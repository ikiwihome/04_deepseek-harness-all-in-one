import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { patchAuth, patchGateway } from '../docker/patch-persistent-login.mjs';
import { patchVideoPreview, patchVideoRoute } from '../docker/patch-video-preview.mjs';
import { patchDownloadPreview, patchDownloadRoute } from '../docker/patch-download-preview.mjs';

// Run against the packages installed in the image, so upstream changes fail loudly.
const passwords = process.env.DSH_PASSWORDS_PKG || '/opt/dsh-passwords/node_modules/dsh-passwords';
const core = process.env.DSH_TEST_CORE_DIR || '/opt/dsh/node_modules/@deepseek-ai';
const authSource = readFileSync(`${passwords}/dist/auth.js`, 'utf8');
const gateway = patchGateway(readFileSync(`${passwords}/dist/gateway.js`, 'utf8'));
const controller = patchDownloadRoute(patchVideoRoute(readFileSync(`${core}/dsh-api-session-controller/lib/index.js`, 'utf8')));

test('patches are idempotent and reject incompatible upstream code', () => {
  assert.equal(patchAuth(patchAuth(authSource)), patchAuth(authSource));
  assert.equal(patchGateway(gateway), gateway);
  assert.equal(patchVideoRoute(controller), controller);
  assert.equal(patchDownloadRoute(controller), controller);
  const preview = patchVideoPreview(readFileSync(`${core}/dsh-client-ui-sidebar-documentpreview/lib/client.js`, 'utf8'));
  assert.equal(patchVideoPreview(preview), preview);
  assert.equal(patchDownloadPreview(patchDownloadPreview(preview)), patchDownloadPreview(preview));
  for (const patch of [patchAuth, patchGateway, patchVideoRoute, patchVideoPreview, patchDownloadPreview, patchDownloadRoute]) assert.throws(() => patch('changed upstream'));
});

test('login tokens have unique ids and no time expiry', () => {
  const source = patchAuth(authSource);
  assert.match(source, /jwtid: randomUUID\(\)/);
  assert.doesNotMatch(source, /expiresIn: TOKEN_TTL/);
});

test('real signed login tokens remain valid after 13 hours and after service recreation', async () => {
  const require = createRequire(`${passwords}/package.json`);
  const bcrypt = require('bcryptjs');
  const { AuthService } = await import(pathToFileURL(`${passwords}/dist/auth.js`));
  const row = { id: 1, username: 'test-user', credential_version: 1, password_hash: bcrypt.hashSync('FixtureOnly@2026', 4) };
  const db = {
    getIpThrottle: () => null, getLoginAttempt: async () => null,
    getUserByUsername: async () => row, resetLoginAttempts: async () => {},
    resetIpThrottle: () => {}, touchLogin: async () => {}, audit: async () => {}
  };
  const config = { jwtSecret: 'test-key-only-never-used-in-deployment' };
  const service = new AuthService(config, db);
  const first = await service.login({ username: row.username, password: 'FixtureOnly@2026' });
  const second = await service.login({ username: row.username, password: 'FixtureOnly@2026' });
  assert.notEqual(first.token, second.token);
  const now = Date.now;
  try {
    Date.now = () => now() + 13 * 3600 * 1000;
    const restarted = new AuthService(config, db);
    assert.equal(restarted.verifyToken(first.token).userId, 1);
  } finally { Date.now = now; }
});

test('logout stays revoked across gateway restarts; password changes invalidate sessions', () => {
  const settings = new Map();
  let row = { username: 'alice', credential_version: 1 };
  const db = { getSetting: key => settings.get(key), setSetting: (key, value) => settings.set(key, value), getUserById: () => row };
  const token = { userId: 1, username: 'alice', cv: 1 };
  const functions = gateway.slice(gateway.indexOf('    function revocationKey('), gateway.indexOf('    /** 子用户权限：'));
  const start = () => vm.runInNewContext(`const sessionCache = new Map(); const SESSION_CACHE_TTL_MS = 30000; ${functions}; ({sessionOf, revokeToken})`, {
    db, auth: { verifyToken: () => token }, createHash, Date,
    readCookie: header => header, COOKIE_NAME: 'session'
  });
  const request = { headers: { cookie: 'test-session' } };
  let runtime = start();
  assert.equal(runtime.sessionOf(request).username, 'alice');
  runtime.revokeToken('test-session');
  assert.equal(runtime.sessionOf(request), null);
  runtime = start();
  assert.equal(runtime.sessionOf(request), null);
  assert.equal(settings.size, 1);
  assert.ok([...settings.keys()][0].startsWith('revoked_session:'));
  request.headers.cookie = 'other-session';
  row.credential_version = 2;
  assert.equal(runtime.sessionOf(request), null);
  row = null;
  assert.equal(runtime.sessionOf(request), null);
});

class FsError extends Error {}
const serveFile = vm.runInNewContext(controller.slice(controller.indexOf('const BASE_HEADERS ='), controller.indexOf('/**\n* File-display contribution.')) + '\nserveFile', {
  Response, ReadableStream, Uint8Array, URL, FsError,
  isAbsolute: value => value.startsWith('/'), mime: { lookup: value => value.endsWith('.mp4') ? 'video/mp4' : 'image/png' }
});
const payload = new Uint8Array(20 * 1024 * 1024 + 7).map((_, index) => index % 251);
const fs = {
  resolve: async path => ({ displayPath: path }),
  stat: async () => ({ type: 'file', size: payload.length }),
  readByteRange: async (_target, { offset, length }) => payload.slice(offset, offset + length),
  readBytes: async () => { throw Object.assign(new FsError(), { code: 'FS_TOO_LARGE' }); }
};
const request = (range, method = 'GET', path = '/movie.mp4') => new Request(`http://localhost/api/file?path=${encodeURIComponent(path)}`, { method, headers: range ? { range } : {} });

test('large video supports HEAD and full streaming beyond the image limit', async () => {
  const head = await serveFile(request(undefined, 'HEAD'), fs, 1024);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(payload.length));
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  const full = await serveFile(request(), fs, 1024);
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), payload);
});

test('video supports seeking, suffixes, bounded open ranges and invalid range errors', async () => {
  for (const [range, offset, length] of [['bytes=7-19', 7, 13], ['bytes=-20', payload.length - 20, 20], ['bytes=0-', 0, 8 * 1024 * 1024]]) {
    const response = await serveFile(request(range), fs, 1024);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${offset}-${offset + length - 1}/${payload.length}`);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), payload.slice(offset, offset + length));
  }
  for (const range of ['bytes=-0', 'bytes=-', 'bytes=99-2', 'bytes=999999999-', 'bytes=0-1,3-4']) {
    assert.equal((await serveFile(request(range), fs, 1024)).status, 416);
  }
});

test('file access checks and image limits are preserved', async () => {
  assert.equal((await serveFile(request(undefined, 'GET', 'relative.mp4'), fs, 1024)).status, 400);
  assert.equal((await serveFile(request(undefined, 'GET', '/image.png'), fs, 1024)).status, 413);
  const denied = { ...fs, resolve: async () => { throw Object.assign(new FsError(), { code: 'FS_SANDBOX_DENIED' }); } };
  assert.equal((await serveFile(request(), denied, 1024)).status, 403);
});

test('original downloads stream complete large files with UTF-8 filenames', async () => {
  for (const name of ['报告 2026.docx', 'slides.pptx', 'table.xlsx', 'readme.md', 'image.png', 'video.mp4']) {
    const response = await serveFile(new Request('http://localhost/api/file?download=1&path=' + encodeURIComponent('/workspace/' + name)), fs, 1024);
    assert.equal(response.status, 200);
    const disposition = response.headers.get('content-disposition');
    assert.ok(disposition.startsWith('attachment;'));
    assert.equal(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]), name);
    assert.equal(response.headers.get('content-length'), String(payload.length));
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), payload);
  }
});

test('download HEAD, empty files, missing files and filesystem denial', async () => {
  const url = 'http://localhost/api/file?download=1&path=/workspace/file.zip';
  const head = await serveFile(new Request(url, { method: 'HEAD' }), fs, 1024);
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(head.headers.get('content-length'), String(payload.length));
  const empty = { ...fs, stat: async () => ({ type: 'file', size: 0 }) };
  assert.equal((await (await serveFile(new Request(url), empty, 1024)).arrayBuffer()).byteLength, 0);
  assert.equal((await serveFile(new Request(url), { ...fs, stat: async () => undefined }, 1024)).status, 404);
  assert.equal((await serveFile(new Request(url), { ...fs, stat: async () => ({ type: 'directory' }) }, 1024)).status, 403);
  const denied = { ...fs, resolve: async () => { throw Object.assign(new FsError(), { code: 'FS_SANDBOX_DENIED' }); } };
  assert.equal((await serveFile(new Request(url), denied, 1024)).status, 403);
});

test('video renderer resolves Remote result envelopes and reports metadata failures', async () => {
  const preview = patchVideoPreview(readFileSync(`${core}/dsh-client-ui-sidebar-documentpreview/lib/client.js`, 'utf8'));
  const component = preview.slice(preview.indexOf('            function VideoBody(props)'), preview.indexOf('            ctx.effect(() => ctx.documentPreviews.register({'));
  for (const ok of [true, false]) {
    const states = [], effects = [];
    let cursor = 0;
    const jsx = (type, props) => ({ type, props });
    const render = vm.runInNewContext(component + '\nVideoBody', {
      ctx: { remote: { workspaceFiles: { stat: async () => ok ? { ok: true, value: { absolutePath: '/workspace/video.mp4' } } : { ok: false, error: {} } } } },
      react: {
        useState: initial => { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = value; }]; },
        useEffect: effect => effects.push(effect)
      },
      react_jsx_runtime: { jsx, jsxs: jsx }, AbortController, document: { baseURI: 'http://localhost/' },
      hostFileOf: () => ({ sessionId: 'test', path: 'video.mp4' }),
      fileMediaUrl: (base, path) => new URL('api/file?path=' + encodeURIComponent(path), base).href
    });
    const props = { resourceAddress: 'test', content: { kind: 'renderer', revision: 1, loaded: () => {}, failed: () => {} } };
    render(props);
    for (const effect of effects.splice(0)) effect();
    await new Promise(resolve => setImmediate(resolve));
    cursor = 0;
    const output = render(props);
    if (ok) assert.equal(output.props.children[0].props.src, 'http://localhost/api/file?path=%2Fworkspace%2Fvideo.mp4');
    else assert.equal(output.props.role, 'alert');
  }
});
