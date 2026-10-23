import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { resolveBuildVersions } from '../docker/resolve-versions.mjs';
import { nativeHostSettings, patchNativeSettingsStatus } from '../docker/patch-passwords-native-settings.mjs';

function registry(range = '>=0.2.1-alpha.1 <0.2.2-0') {
  const latest = { '@deepseek-ai/dsh': '0.2.1-rc.2', 'dsh-passwords': '2.7.8', '@linxin666/dsh-client-ui-skin-center': '0.4.8', 'ds-bot': '0.1.7' };
  return (spec, field) => {
    if (field === 'peerDependencies') return null;
    if (field === 'devDependencies') return { '@deepseek-ai/dsh': range };
    if (field === 'version') {
      const index = spec.lastIndexOf('@');
      return spec.slice(index + 1) === 'latest' ? latest[spec.slice(0, index)] : spec.slice(index + 1);
    }
    throw new Error('Unexpected registry query: ' + spec);
  };
}

test('latest DSH tag wins and rc is never silently excluded', () => {
  const result = resolveBuildVersions({ env: {}, view: registry() });
  assert.equal(result.dsh, '0.2.1-rc.2');
  assert.equal(result.skinCenter, '0.4.8');
  assert.equal(result.dshResolution, 'latest-tag');
  assert.equal(result.versionPriority, 'dsh-first');
});
test('unsupported gateway fails explicitly rather than downgrading DSH', () => {
  assert.throws(() => resolveBuildVersions({ env: {}, view: registry('<0.2.1-rc.2') }), /will not be silently downgraded/);
});
test('explicit DSH pins remain supported', () => {
  assert.equal(resolveBuildVersions({ env: { DSH_VERSION: '0.2.1-alpha.2' }, view: registry() }).dsh, '0.2.1-alpha.2');
});
test('gateway recognizes native Host reads and writes while rejecting memory/loopback implementations', () => {
  const native = 'var SettingsDescribeMirror = class; await this.ctx.remote.settings.describe(); await this.ctx.remote.settings.mutate(';
  const before = 'return !s.includes(SETTINGS_FROM) && !s.includes(SETTINGS_ALPHA_FROM) && s.includes(SETTINGS_TO);';
  const patched = patchNativeSettingsStatus(before);
  assert.equal(patchNativeSettingsStatus(patched), patched);
  const evaluate = source => vm.runInNewContext(`(function () { ${patched} })()`, {
    s: source, SETTINGS_FROM: 'connection.isLoopback ? "host" : "memory"', SETTINGS_ALPHA_FROM: 'ctx.remote.$host.isLoopback ? "host" : "memory"', SETTINGS_TO: '"host"'
  });
  assert.equal(nativeHostSettings(native), true);
  assert.equal(evaluate(native), true);
  assert.equal(evaluate(native + ' isLoopback'), false);
  assert.equal(evaluate(native + ' "memory"'), false);
  assert.equal(evaluate(native.replace('remote.settings.mutate(', 'not-supported(')), false);
  assert.equal(evaluate('const mode = "host";'), true);
  assert.throws(() => patchNativeSettingsStatus('unknown gateway'), /anchor changed/);
});

