import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Persistent login patch anchor changed: ${before}`);
  return source.replace(before, after);
}

export function patchAuth(source) {
  if (source.includes('// dsh-local: persistent-login')) return source;
  source = replaceOnce(source, "const TOKEN_TTL = '12h';", '// dsh-local: persistent-login\nimport { randomUUID } from "node:crypto";');
  return replaceOnce(source, '{ expiresIn: TOKEN_TTL }', '{ jwtid: randomUUID() }');
}

export function patchGateway(source) {
  if (source.includes('// dsh-local: persistent-login')) return source;
  const start = source.indexOf('    const revokedTokens = new Map();');
  const end = source.indexOf('    function sessionOf(req)', start);
  if (start < 0 || end < 0) throw new Error('Persistent login revocation anchors changed');
  source = source.slice(0, start) + `    // dsh-local: persistent-login
    // Store token fingerprints in the existing persistent database. Logout survives restart.
    function revocationKey(token) {
        return 'revoked_session:' + createHash('sha256').update(token).digest('hex');
    }
    function revokeToken(token) {
        db.setSetting(revocationKey(token), '1');
        sessionCache.delete(token);
    }
    function isTokenRevoked(token) {
        return db.getSetting(revocationKey(token)) === '1';
    }
` + source.slice(end);
  source = replaceOnce(source, 'Max-Age=43200', 'Max-Age=34560000');
  // Browsers cap persistent cookies at 400 days; refresh on authenticated page visits.
  return replaceOnce(source, '    /** 统一 403 页面（封禁 / 权限拒绝） */', `    app.use((req, res, next) => {
        if (req.method === 'GET' && req.accepts('html') && sessionOf(req) !== null) {
            const token = readCookie(req.headers.cookie, COOKIE_NAME);
            res.append('Set-Cookie', \`\${COOKIE_NAME}=\${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000\${requestIsSecure(req) ? '; Secure' : ''}\`);
        }
        next();
    });
    /** 统一 403 页面（封禁 / 权限拒绝） */`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.env.DSH_PASSWORDS_PKG || '/opt/dsh-passwords/node_modules/dsh-passwords';
  for (const [file, patch] of [['auth.js', patchAuth], ['gateway.js', patchGateway]]) {
    const target = path.join(root, 'dist', file);
    writeFileSync(target, patch(readFileSync(target, 'utf8')));
    console.log(`[persistent-login] patched ${target}`);
  }
}
