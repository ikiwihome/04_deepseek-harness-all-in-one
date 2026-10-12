#!/usr/bin/env node
/**
 * First-boot account bootstrap for the dsh-passwords gateway.
 *
 * dsh-passwords has no "default password" setting of its own: a fresh platform
 * opens on a one-time setup page that asks for SETUP_KEY + a user name + a
 * password. This script drives that same page over HTTP (the very same
 * double-submit CSRF + form contract the browser uses), so a container can come
 * up already usable with the credentials configured in the Dockerfile or in
 * docker-compose.yml:
 *
 *   GET  /gateway/login   -> CSRF cookie `dsh_csrf` + hidden `csrf` form field
 *                            (or the plain login form when already initialized)
 *   POST /gateway/setup   -> x-www-form-urlencoded: csrf, setupKey, username,
 *                            password, confirm
 *   302 -> /gateway/login marks success
 *
 * It is deliberately fail-soft: every failure is logged and the container keeps
 * running with the manual setup page still available.
 *
 * Environment:
 *   MCP_GATEWAY_PORT             gateway port inside the container (default 3088)
 *   DSH_ADMIN_USERNAME           main user name (default `admin`)
 *   DSH_ADMIN_PASSWORD           password for that user (empty -> script exits)
 *   DSH_ADMIN_PASSWORD_FILE      read the password from a file instead
 *   DSH_ADMIN_SETUP_TIMEOUT_MS   how long to wait for the gateway (default 300000)
 *   DSH_PASSWORDS_ENV_FILE       gateway .env, used to recover a generated
 *                                SETUP_KEY when the environment does not carry one
 *   SETUP_KEY                    one-time setup key (takes precedence over .env)
 */
import { readFileSync } from 'node:fs';

const TAG = '[dsh-passwords-bootstrap]';
const PORT = (process.env.MCP_GATEWAY_PORT ?? '').trim() || '3088';
const ORIGIN = `http://127.0.0.1:${PORT}`;
const USERNAME = (process.env.DSH_ADMIN_USERNAME ?? '').trim() || 'admin';
const TIMEOUT_MS = Number.parseInt((process.env.DSH_ADMIN_SETUP_TIMEOUT_MS ?? '').trim() || '300000', 10);
const RETRY_MS = 2000;
const CSRF_COOKIE = 'dsh_csrf';
/** Same rules dsh-passwords enforces server-side (auth.js). */
const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;
const PASSWORD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,128}$/;

const log = (message) => console.log(`${TAG} ${message}`);
const warn = (message) => console.warn(`${TAG} ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Strip one trailing line break, which is all a Docker secret file adds. */
function stripTrailingNewline(value) {
  return value.replace(/\r?\n$/, '');
}

function readPassword() {
  const direct = process.env.DSH_ADMIN_PASSWORD ?? '';
  if (direct !== '') return direct;
  const file = (process.env.DSH_ADMIN_PASSWORD_FILE ?? '').trim();
  if (file === '') return '';
  try {
    return stripTrailingNewline(readFileSync(file, 'utf8'));
  } catch (error) {
    warn(`cannot read DSH_ADMIN_PASSWORD_FILE=${file}: ${String(error)}`);
    return '';
  }
}

/**
 * Recover the setup key: an explicit environment value wins; otherwise read the
 * one docker-init persisted, mirroring the gateway's own precedence.
 */
function readSetupKey() {
  const fromEnv = (process.env.SETUP_KEY ?? '').trim();
  if (fromEnv !== '') return fromEnv;
  const file = (process.env.DSH_PASSWORDS_ENV_FILE ?? '').trim() || '/data/dsh-passwords/.env';
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (line.trimStart().startsWith('#')) continue;
      const match = /^\s*SETUP_KEY\s*=\s*(.*?)\s*$/.exec(line);
      if (match) return match[1].replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '').trim();
    }
  } catch {
    /* Reported by the caller as a missing setup key. */
  }
  return '';
}

function storeCookies(response, jar) {
  const lines =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter((value) => value !== null);
  for (const line of lines) {
    const pair = String(line).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader(jar) {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** GET that follows redirects by hand so every Set-Cookie is kept. */
async function getPage(url, jar) {
  let current = url;
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await fetch(current, {
      method: 'GET',
      redirect: 'manual',
      // No keep-alive socket: the process must be able to end as soon as the
      // work is done, without waiting for an idle connection to time out.
      headers: { connection: 'close', ...(jar.size > 0 ? { cookie: cookieHeader(jar) } : {}) },
    });
    storeCookies(response, jar);
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return { status: response.status, body: await response.text() };
  }
  throw new Error('too many redirects');
}

/** The setup page renders <input type="hidden" name="csrf" value="…" />. */
function extractCsrf(html) {
  const patterns = [
    /<input[^>]*name="csrf"[^>]*value="([^"]+)"/i,
    /<input[^>]*value="([^"]+)"[^>]*name="csrf"/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match) return match[1];
  }
  return null;
}

function extractError(html) {
  const match = /<div class="error-bar"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  return match ? match[1].replace(/<[^>]*>/g, '').trim() : '';
}

/**
 * Submit the setup form.
 * @returns "created" | "already" | "retry" | "fatal".
 */
async function submitSetup(jar, csrf, setupKey) {
  const response = await fetch(`${ORIGIN}/gateway/setup`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      connection: 'close',
      cookie: cookieHeader(jar),
    },
    body: new URLSearchParams({
      csrf,
      setupKey,
      username: USERNAME,
      password: PASSWORD,
      confirm: PASSWORD,
    }).toString(),
  });
  if (response.status === 302 || response.status === 303) {
    // Drain the body so no socket is left half-read when the process ends.
    await response.arrayBuffer().catch(() => undefined);
    return 'created';
  }
  if (response.status === 409) return 'already';
  const body = await response.text();
  const localized = extractError(body);
  if (response.status === 403) {
    // CSRF cookie/field mismatch: the page rotates its token, so read it again.
    warn(`setup rejected with 403 (CSRF): ${localized === '' ? 'retrying' : localized}`);
    return 'retry';
  }
  if (response.status === 401) {
    warn(`setup rejected: SETUP_KEY is wrong${localized === '' ? '' : ` — ${localized}`}`);
    return 'fatal';
  }
  warn(
    `setup rejected with HTTP ${response.status}${localized === '' ? '' : ` — ${localized}`}; ` +
      'check DSH_ADMIN_USERNAME / DSH_ADMIN_PASSWORD against the gateway password policy',
  );
  return 'fatal';
}

const PASSWORD = readPassword();
if (PASSWORD === '') {
  log('no DSH_ADMIN_PASSWORD configured; leaving the manual setup page in place');
  process.exit(0);
}
if (!USERNAME_RE.test(USERNAME)) {
  warn(`DSH_ADMIN_USERNAME=${JSON.stringify(USERNAME)} is invalid (3-32 chars of A-Z a-z 0-9 _ -)`);
  process.exit(1);
}
if (!PASSWORD_RE.test(PASSWORD) || Buffer.byteLength(PASSWORD, 'utf8') > 72) {
  warn(
    'DSH_ADMIN_PASSWORD does not satisfy the gateway policy: at least 12 characters with ' +
      'an uppercase letter, a lowercase letter, a digit and a symbol (at most 72 bytes)',
  );
  process.exit(1);
}

const setupKey = readSetupKey();
if (setupKey === '') {
  warn(
    'no SETUP_KEY available from the environment or the gateway .env yet; ' +
      'retrying while the gateway initializes',
  );
}

const deadline = Date.now() + (Number.isFinite(TIMEOUT_MS) && TIMEOUT_MS > 0 ? TIMEOUT_MS : 300000);
let lastNote = 'gateway not reachable yet';
/** null while still trying; 0/1 once the outcome is decided. */
let exitCode = null;

while (exitCode === null && Date.now() < deadline) {
  try {
    const jar = new Map();
    const page = await getPage(`${ORIGIN}/gateway/login`, jar);
    if (page.status === 200) {
      if (page.body.includes('action="/gateway/setup"')) {
        const csrf = extractCsrf(page.body);
        const key = setupKey === '' ? readSetupKey() : setupKey;
        if (csrf === null) {
          lastNote = 'setup page without a CSRF field';
        } else if (key === '') {
          lastNote = 'setup page reached, but SETUP_KEY is not available yet';
        } else {
          const outcome = await submitSetup(jar, csrf, key);
          if (outcome === 'created') {
            log(`main user "${USERNAME}" created; sign in with the configured password`);
            exitCode = 0;
          } else if (outcome === 'already') {
            log('platform is already initialized; nothing to do');
            exitCode = 0;
          } else if (outcome === 'fatal') {
            exitCode = 1;
          } else {
            lastNote = 'setup attempt rejected; retrying';
          }
        }
      } else if (page.body.includes('action="/gateway/login"')) {
        log('platform is already initialized; nothing to do');
        exitCode = 0;
      } else {
        lastNote = 'unexpected page from /gateway/login';
      }
    } else {
      lastNote = `/gateway/login answered HTTP ${page.status}`;
    }
  } catch (error) {
    lastNote = String(error?.cause?.code ?? error?.message ?? error);
  }
  if (exitCode === null) await sleep(RETRY_MS);
}

// Exit code only: every response body is drained first, so the process ends by
// itself and no buffered log line is lost to process.exit().
if (exitCode === null) {
  warn(`gave up after ${Math.round(TIMEOUT_MS / 1000)}s (${lastNote}); use the browser setup page instead`);
  exitCode = 1;
}
process.exitCode = exitCode;
