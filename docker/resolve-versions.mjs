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
 * Inside that range, auto mode excludes `-rc` prereleases and additionally picks
 * the newest version whose client bundles still contain the strings dsh-passwords
 * patches: rc/alpha releases can refactor that code (0.2.1-alpha.3+ and rc.1/rc.2
 * did), after which the gateway's fail-closed patch check refuses to start. The
 * anchors are read from the resolved dsh-passwords tarball itself, and the probe
 * downloads only the small `@deepseek-ai/dsh-client-ui-settings` bundle — so this
 * stays correct when dsh-passwords changes its anchors, without installing DSH
 * candidates. An explicit pin (e.g. DSH_VERSION=0.2.1-rc.2) still wins; the
 * build-time patch gate then decides whether that build is usable.
 *
 * Outputs:
 *   /opt/dsh-versions.json   what was resolved (also printed to the build log)
 *   /opt/dsh-versions.env    DSH_VERSION / DSH_PASSWORDS_VERSION /
 *                            SKIN_CENTER_VERSION, shell-sourceable for RUN steps
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

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

/**
 * Whether a version is an rc prerelease (`0.2.1-rc.2`, `0.2.1-rc1`, ...).
 * These are excluded from DSH auto resolution; see the header comment.
 */
function isRcPrerelease(version) {
  const parsed = parseVersion(version);
  return parsed !== null && parsed.pre.some((part) => /^rc\d*$/i.test(part));
}

/** Deduplicated concrete versions, newest first. */
function sortedNewestFirst(versions) {
  const concrete = [...new Set(versions.map((v) => String(v)).filter((v) => parseVersion(v) !== null))];
  return concrete.sort((left, right) => compareVersions(right, left));
}

/** Download one npm tarball (the resolver runs on Node >= 22, so global fetch exists). */
async function fetchTarball(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Read one file out of a .tgz without shelling out to tar (like npm's own
 * bin/npm-cli.js, the image has no guaranteed `tar` in a future base change).
 * Returns null when a regular entry with that suffix is absent.
 */
function readFileFromTarGz(buffer, suffix) {
  const tar = gunzipSync(buffer);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    /* v8 ignore next -- all-zero block terminates the archive */
    if (header.every((byte) => byte === 0)) return null;
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const name = prefix === '' ? rawName : `${prefix}/${rawName}`;
    const size = Number.parseInt(header.subarray(124, 136).toString('utf8').trim() || '0', 8);
    const type = String.fromCharCode(header[156]);
    offset += 512;
    const body = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if ((type === '0' || type === '\0' || type === '') && name.endsWith(suffix)) return body.toString('utf8');
  }
  return null;
}

/**
 * The client-bundle strings dsh-passwords replaces, read from its own published
 * tarball so this follows the plugin instead of duplicating its internals.
 * Empty list (with a warning) when the shape is unknown; the build-time patch
 * gate remains the final authority.
 */
async function passwordsPatchAnchors(version) {
  const tarball = npmView(`${PASSWORDS_PACKAGE}@${version}`, 'dist.tarball');
  if (typeof tarball !== 'string' || tarball.trim() === '') return [];
  const source = readFileFromTarGz(await fetchTarball(tarball.trim()), 'package/dist/patch.js');
  if (source === null) return [];
  return [
    ...new Set(
      [...source.matchAll(/const SETTINGS_(?:ALPHA_)?FROM = '((?:[^'\\]|\\.)*)'/g)].map((match) =>
        match[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'),
      ),
    ),
  ];
}

/**
 * Whether one DSH version's settings client bundle still contains an anchor
 * dsh-passwords can patch. Only that small bundle is downloaded; DSH itself is
 * not installed until the resolver has chosen a version.
 */
async function settingsBundleHasAnchor(version, anchors) {
  const tarball = npmView(`@deepseek-ai/dsh-client-ui-settings@${version}`, 'dist.tarball');
  if (typeof tarball !== 'string' || tarball.trim() === '') return { ok: false, reason: 'settings package missing' };
  const bundle = readFileFromTarGz(await fetchTarball(tarball.trim()), 'package/lib/client.js');
  if (bundle === null) return { ok: false, reason: 'settings bundle missing' };
  return { ok: anchors.some((anchor) => bundle.includes(anchor)), reason: 'patch anchor absent' };
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
let dshAnchors = [];
let dshResolution = 'pinned';
let dshVersion;
if (isPinned(dshPinned)) {
  dshVersion = dshPinned.trim();
} else {
  const compatible = fromView(npmView(`${DSH_PACKAGE}@${dshRange}`, 'version'));
  const rejected = compatible.filter(isRcPrerelease).map((version) => `${version} (rc prerelease)`);
  const ranked = sortedNewestFirst(compatible.filter((version) => !isRcPrerelease(version)));
  if (ranked.length === 0) {
    fail(
      `no ${DSH_PACKAGE} release satisfies ${JSON.stringify(dshRange)} once rc prereleases are excluded ` +
        `(range only offered: ${JSON.stringify(compatible)}) — pin an explicit version with DSH_VERSION`,
    );
  }
  try {
    dshAnchors = await passwordsPatchAnchors(passwordsVersion);
  } catch (error) {
    console.warn(`[resolve-versions] could not inspect ${PASSWORDS_PACKAGE} patch anchors: ${error.message}`);
  }
  if (dshAnchors.length === 0) {
    dshResolution = 'rc-filter-fallback';
    dshVersion = ranked[0];
    console.warn(
      `[resolve-versions] ${PASSWORDS_PACKAGE} patch anchors unknown; picked the newest non-rc version ` +
        `${dshVersion}. The build-time patch gate will verify compatibility.`,
    );
  } else {
    dshResolution = 'patch-anchor';
    dshVersion = null;
    for (const candidate of ranked) {
      let verdict;
      try {
        verdict = await settingsBundleHasAnchor(candidate, dshAnchors);
      } catch (error) {
        rejected.push(`${candidate} (probe failed: ${error.message})`);
        continue;
      }
      if (verdict.ok) {
        dshVersion = candidate;
        break;
      }
      rejected.push(`${candidate} (${verdict.reason})`);
    }
    if (dshVersion === null) {
      fail(
        `no ${DSH_PACKAGE} release in ${JSON.stringify(dshRange)} is compatible with the ` +
          `${PASSWORDS_PACKAGE}@${passwordsVersion} client bundles; rejected: ${rejected.join(', ')} — ` +
          `pin an explicit version with DSH_VERSION or upgrade ${PASSWORDS_PACKAGE}`,
      );
    }
    if (rejected.length > 0) console.log(`[resolve-versions] skipped: ${rejected.join(', ')}`);
  }
}
console.log(
  `[resolve-versions] ${DSH_PACKAGE} ${dshVersion}${
    dshResolution === 'pinned'
      ? ' (pinned)'
      : dshResolution === 'patch-anchor'
        ? ` (newest patch-compatible in ${dshRange}; rc excluded)`
        : ` (newest non-rc in ${dshRange}; anchors unknown)`
  }`,
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
  dshResolution,
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
