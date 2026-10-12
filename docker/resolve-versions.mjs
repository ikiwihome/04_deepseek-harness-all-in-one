#!/usr/bin/env node
/**
 * Resolve the newest mutually-compatible versions of the three components from
 * the npm registry, at image build time.
 *
 * Build args (each defaults to `latest`):
 *   DSH_VERSION              @deepseek-ai/dsh
 *   DSH_PASSWORDS_VERSION    dsh-passwords
 *   SKIN_CENTER_VERSION      @linxin666/dsh-client-ui-skin-center
 * A concrete value (e.g. `2.7.8`) pins that component instead of tracking.
 *
 * DSH is deliberately NOT taken from the npm `latest` dist-tag: for DSH that tag
 * currently resolves to 0.2.0-rc.2, which dsh-passwords refuses to run with. The
 * compatibility gate is read from the resolved dsh-passwords' own declared
 * dependency range (`>=0.2.1-alpha.1 <0.2.2-0`) and npm resolves the newest
 * version inside it — so following the latest plugin also follows its gate.
 *
 * Outputs:
 *   /opt/dsh-versions.json   what was resolved (also printed to the build log)
 *   /opt/dsh-versions.env    DSH_VERSION / DSH_PASSWORDS_VERSION /
 *                            SKIN_CENTER_VERSION, shell-sourceable for RUN steps
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT_JSON = process.env.DSH_VERSIONS_JSON?.trim() || '/opt/dsh-versions.json';
const OUT_ENV = process.env.DSH_VERSIONS_ENV?.trim() || '/opt/dsh-versions.env';
const DSH_PACKAGE = '@deepseek-ai/dsh';
const PASSWORDS_PACKAGE = 'dsh-passwords';
const SKIN_CENTER_PACKAGE = '@linxin666/dsh-client-ui-skin-center';
const DS_BOT_PACKAGE = 'ds-bot';
const REGISTRY_FALLBACK = 'latest';

/**
 * npm's JS entry, resolved next to the running node.
 *
 * `execFileSync('npm', ...)` cannot work portably: on Windows `npm` is a `.cmd`
 * shim that Node >= 22 refuses to spawn without a shell (CVE-2024-27980), and a
 * shell is not an option here because version ranges contain `<`, `>` and
 * spaces. Calling npm's own entry script through node avoids both problems.
 */
function npmCliPath() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Ask npm for one field. `npm view <spec>` without a field prints the whole
 * packument, so the field is always passed explicitly (and as its own argument,
 * never glued to the spec).
 */
function npmView(spec, field) {
  const cli = npmCliPath();
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 };
  const args = ['view', spec, ...(field === undefined ? [] : [field]), '--json'];
  try {
    const raw = (
      cli === null ? execFileSync('npm', args, options) : execFileSync(process.execPath, [cli, ...args], options)
    ).trim();
    return raw === '' ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The DSH compatibility gate as the plugin itself declares it. */
function declaredDshRange(version) {
  for (const field of ['devDependencies', 'peerDependencies', 'dependencies']) {
    const declared = npmView(`${PASSWORDS_PACKAGE}@${version}`, field);
    const range = typeof declared === 'object' && declared !== null ? declared[DSH_PACKAGE] : undefined;
    if (typeof range === 'string' && range.trim() !== '') return { range: range.trim(), field };
  }
  return null;
}

/** Minimal semver precedence (numeric triple, then prerelease rules). */
function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value).trim());
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split('.'),
  };
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // a release outranks a prerelease
  if (b.length === 0) return -1;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const delta = Number(left) - Number(right);
      if (delta !== 0) return delta < 0 ? -1 : 1;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1; // numeric identifiers sort lower
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return 0;
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) throw new Error(`not a semver version: ${left === null ? a : b}`);
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.pre, right.pre);
}

function maxVersion(versions) {
  const concrete = versions.map((v) => String(v)).filter((v) => parseVersion(v) !== null);
  if (concrete.length === 0) return null;
  return concrete.reduce((best, candidate) => (compareVersions(candidate, best) > 0 ? candidate : best));
}

/** `npm view <pkg>@<range> version --json` returns one string or a list. */
function fromView(value) {
  if (value === null) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function isPinned(value) {
  const spec = (value ?? '').trim();
  return spec !== '' && spec !== REGISTRY_FALLBACK && spec !== 'none';
}

function fail(message) {
  console.error(`[resolve-versions] ${message}`);
  process.exit(1);
}

// ── dsh-passwords ─────────────────────────────────────────────────────────
const passwordsPinned = process.env.DSH_PASSWORDS_VERSION ?? '';
const passwordsVersion = isPinned(passwordsPinned)
  ? passwordsPinned.trim()
  : maxVersion(fromView(npmView(`${PASSWORDS_PACKAGE}@${REGISTRY_FALLBACK}`, 'version')));
if (passwordsVersion === null || passwordsVersion === '' || parseVersion(passwordsVersion) === null) {
  fail(`could not resolve a concrete ${PASSWORDS_PACKAGE} version (network? pinned value invalid?)`);
}
console.log(`[resolve-versions] ${PASSWORDS_PACKAGE} ${passwordsVersion}${isPinned(passwordsPinned) ? ' (pinned)' : ' (latest)'}`);

// ── DSH, inside the range that dsh-passwords declares ─────────────────────
const declared = declaredDshRange(passwordsVersion);
if (declared === null) {
  fail(`${PASSWORDS_PACKAGE}@${passwordsVersion} does not declare a ${DSH_PACKAGE} dependency range`);
}
const dshRange = declared.range;
const dshPinned = process.env.DSH_VERSION ?? '';
let dshVersion;
if (isPinned(dshPinned)) {
  dshVersion = dshPinned.trim();
} else {
  dshVersion = maxVersion(fromView(npmView(`${DSH_PACKAGE}@${dshRange}`, 'version')));
  if (dshVersion === null) fail(`no ${DSH_PACKAGE} version satisfies ${JSON.stringify(dshRange)}`);
}
console.log(
  `[resolve-versions] ${DSH_PACKAGE} ${dshVersion}${isPinned(dshPinned) ? ' (pinned)' : ` (newest in ${dshRange})`}`,
);
if (parseVersion(dshVersion) === null) fail(`${DSH_PACKAGE} ${dshVersion} is not a concrete version`);

// ── skin center ───────────────────────────────────────────────────────────
const skinPinned = process.env.SKIN_CENTER_VERSION ?? '';
const skinVersion = isPinned(skinPinned)
  ? skinPinned.trim()
  : maxVersion(fromView(npmView(`${SKIN_CENTER_PACKAGE}@${REGISTRY_FALLBACK}`, 'version')));
if (skinVersion === null || skinVersion === '' || parseVersion(skinVersion) === null) {
  fail(`could not resolve a concrete ${SKIN_CENTER_PACKAGE} version`);
}
console.log(`[resolve-versions] ${SKIN_CENTER_PACKAGE} ${skinVersion}${isPinned(skinPinned) ? ' (pinned)' : ' (latest)'}`);

// ── ds-bot (installed, but deliberately not enabled) ──────────────────────
const dsBotPinned = process.env.DS_BOT_VERSION ?? '';
const dsBotVersion = isPinned(dsBotPinned)
  ? dsBotPinned.trim()
  : maxVersion(fromView(npmView(`${DS_BOT_PACKAGE}@${REGISTRY_FALLBACK}`, 'version')));
if (dsBotVersion === null || dsBotVersion === '' || parseVersion(dsBotVersion) === null) {
  fail(`could not resolve a concrete ${DS_BOT_PACKAGE} version`);
}
// ds-bot is only *installed* at first boot (into the profile), so a pin that is
// well-formed but does not exist would otherwise blow up there instead of here.
if (isPinned(dsBotPinned) && npmView(`${DS_BOT_PACKAGE}@${dsBotVersion}`, 'version') === null) {
  fail(`pinned ${DS_BOT_PACKAGE} ${dsBotVersion} does not exist on the registry`);
}
console.log(`[resolve-versions] ${DS_BOT_PACKAGE} ${dsBotVersion}${isPinned(dsBotPinned) ? ' (pinned)' : ' (latest)'}`);

// ── write the results ─────────────────────────────────────────────────────
const resolvedAt = new Date().toISOString();
const document = {
  resolvedAt,
  dsh: dshVersion,
  dshPasswords: passwordsVersion,
  skinCenter: skinVersion,
  dsBot: dsBotVersion,
  dshRange,
};
// The env file uses RESOLVED_* names on purpose: the build args are called
// DSH_VERSION / DSH_PASSWORDS_VERSION / SKIN_CENTER_VERSION, and Docker expands
// `${...}` in a RUN from the ARG values *before* the shell runs — a sourced file
// that reuses those names would be silently overridden by the (default `latest`)
// build arg.
const env = [
  `# resolved ${resolvedAt}`,
  `RESOLVED_DSH_VERSION=${dshVersion}`,
  `RESOLVED_DSH_PASSWORDS_VERSION=${passwordsVersion}`,
  `RESOLVED_SKIN_CENTER_VERSION=${skinVersion}`,
  `RESOLVED_DS_BOT_VERSION=${dsBotVersion}`,
  '',
].join('\n');

mkdirSync(path.dirname(OUT_JSON), { recursive: true });
writeFileSync(OUT_JSON, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
writeFileSync(OUT_ENV, env, 'utf8');
console.log(JSON.stringify(document));
