#!/usr/bin/env node
/**
 * Register the web-profile bundle plugins — precisely, idempotently, with a
 * single `pnpm install`, and without ever depending on pnpm's exit code.
 *
 * Plugins:
 *   dsh-local-defaults                     image defaults as a patch layer BELOW
 *                                          the user's profile patch (link: into
 *                                          the image) — theme = light
 *   @linxin666/dsh-client-ui-skin-center   皮肤管理中心 (registry, version from
 *                                          the image's resolved /opt/dsh-versions.json)
 *   dsh-passwords                          password gateway (link: into the image)
 *   ds-bot                                 installed into the profile but NOT in
 *                                          the bundle layer: installed, disabled.
 *                                          Enable it later in 设置 → 插件.
 *
 * Two container-specific lessons are baked in here:
 *
 * 1. ONE install. dsh-passwords ships `scripts/register-plugin.mjs`, which
 *    appends its own entry and then runs `pnpm install`. If both plugins are
 *    registered up front, that second invocation is unnecessary and the vendor
 *    script takes its documented "dependencies already ready" short-circuit.
 *
 * 2. Never wait for pnpm to exit. pnpm 11.7.0 intermittently finishes an install
 *    (prints `Done`, state fully materialised) and then never exits — observed
 *    in this container as an idle process with live libuv workers and no
 *    sockets. It reproduces only some of the time, on installs that also remove
 *    packages (i.e. version bumps). So the install is spawned asynchronously and
 *    success is decided by polling the resulting node_modules state; a process
 *    that is still alive after the state is complete gets a grace period and is
 *    then terminated.
 *
 * Why not `dsh plugin add`: its reconcile adds EVERY dependency declaring
 * `dsh.bundle` to the bundle layer and raises `duplicate loader entry id` once
 * another bundle-plugin is registered.
 *
 * Environment:
 *   DSH_HOME                     harness home (default ~/.dsh); profile is
 *                                $DSH_HOME/profiles/web
 *   DSH_SKIN_CENTER_VERSION      explicit skin center version; unset/`latest`
 *                                reads /opt/dsh-versions.json
 *   DSH_VERSIONS_JSON            override the baked resolution file
 *   DSH_PASSWORDS_PKG            dsh-passwords package root to `link:`; when
 *                                absent the vendor script registers it instead
 *   DSH_SETUP_TIMEOUT_S          install budget in seconds (default 300)
 *   DSH_PNPM_EXIT_GRACE_S        grace period for a finished-but-alive pnpm
 *                                before it is killed (default 10)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const SKIN_CENTER_NAME = '@linxin666/dsh-client-ui-skin-center';
const PASSWORDS_NAME = 'dsh-passwords';
const DEFAULTS_NAME = 'dsh-local-defaults';
const DS_BOT_NAME = 'ds-bot';
const PASSWORDS_PKG = process.env.DSH_PASSWORDS_PKG?.trim() || '';
const DEFAULTS_PKG = process.env.DSH_DEFAULTS_PKG?.trim() || '/opt/dsh-defaults';
const VERSIONS_JSON = process.env.DSH_VERSIONS_JSON?.trim() || '/opt/dsh-versions.json';

const WEB_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
const PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`;

/** Read one field of the image's baked version resolution. */
function bakedVersions() {
  try {
    const parsed = JSON.parse(readFileSync(VERSIONS_JSON, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const baked = bakedVersions();
const requested = (process.env.DSH_SKIN_CENTER_VERSION ?? '').trim();
const skinCenterVersion =
  requested === '' || requested === 'latest'
    ? typeof baked.skinCenter === 'string' && baked.skinCenter.trim() !== ''
      ? baked.skinCenter.trim()
      : '0.4.4'
    : requested;
const requestedBot = (process.env.DS_BOT_VERSION ?? '').trim();
const dsBotVersion =
  requestedBot === '' || requestedBot === 'latest'
    ? typeof baked.dsBot === 'string' && baked.dsBot.trim() !== ''
      ? baked.dsBot.trim()
      : '0.1.2'
    : requestedBot;
const passwordsLinked = PASSWORDS_PKG !== '' && existsSync(PASSWORDS_PKG);
const defaultsLinked = existsSync(path.join(DEFAULTS_PKG, 'cordis.patch.yml'));
const timeoutMs = Math.max(30, Number.parseInt(process.env.DSH_SETUP_TIMEOUT_S ?? '', 10) || 300) * 1000;
const graceMs = Math.max(0, Number.parseInt(process.env.DSH_PNPM_EXIT_GRACE_S ?? '', 10) || 10) * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readVersion(dir) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Expected installed version for a manifest spec (`0.4.6` or `link:/path`). */
function expectedVersion(spec) {
  return spec.startsWith('link:') ? readVersion(spec.slice(5)) : spec;
}

/**
 * Start pnpm. Windows: pnpm is a `.cmd` shim that Node >= 22 refuses to spawn
 * without a shell (CVE-2024-27980), so cmd.exe is invoked explicitly with fixed
 * quote/percent/whitespace-free literals.
 */
function spawnPnpm(args, cwd) {
  if (process.platform !== 'win32') return spawn('pnpm', args, { cwd, stdio: 'inherit' });
  if (args.some((arg) => /["%\s]/.test(arg))) return null;
  const line = ['pnpm.cmd', ...args].join(' ');
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], { cwd, stdio: 'inherit' });
}

/** Ensure one top-level `key:` exists in the pnpm workspace file (append-only). */
function ensureWorkspaceKey(filePath, key, lines) {
  const raw = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  if (new RegExp(`^\\s*${key}\\s*:`, 'm').test(raw)) return false;
  const head = raw.replace(/\s*$/, '');
  writeFileSync(filePath, `${head === '' ? '' : `${head}\n\n`}${lines.join('\n')}\n`, 'utf8');
  return true;
}

const dshHome = process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh');
const profileDir = path.join(dshHome, 'profiles', 'web');
const manifestPath = path.join(profileDir, 'package.json');

mkdirSync(profileDir, { recursive: true });

// 1) Read (or initialize, exactly like dsh's own profile template) the manifest.
let manifest;
let manifestChanged = false;
if (existsSync(manifestPath)) {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} else {
  manifest = {
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...WEB_BUNDLES] } },
  };
  manifestChanged = true;
}

// 2) Touch only these plugins' dependency rows and bundle rows.
if (!manifest.dependencies || typeof manifest.dependencies !== 'object') {
  manifest.dependencies = {};
  manifestChanged = true;
}
if (!manifest.dsh || typeof manifest.dsh !== 'object') {
  manifest.dsh = {};
  manifestChanged = true;
}
if (!manifest.dsh.profile || typeof manifest.dsh.profile !== 'object') {
  manifest.dsh.profile = {};
  manifestChanged = true;
}
if (!Array.isArray(manifest.dsh.profile.bundles)) {
  manifest.dsh.profile.bundles = [...WEB_BUNDLES];
  manifestChanged = true;
}

/**
 * Everything this script manages.
 *
 * `bundle: true`  → also belongs to the profile's bundle layer (loaded by DSH).
 * `bundle: false` → installed into the profile's node_modules but NOT loaded:
 *                   that is "installed but not enabled" (ds-bot). The user can
 *                   switch it on later in 设置 → 插件, which adds the bundle row;
 *                   this script never removes such a row.
 */
const wanted = [];
if (defaultsLinked) wanted.push({ name: DEFAULTS_NAME, spec: `link:${DEFAULTS_PKG}`, bundle: true });
wanted.push({ name: SKIN_CENTER_NAME, spec: skinCenterVersion, bundle: true });
if (passwordsLinked) wanted.push({ name: PASSWORDS_NAME, spec: `link:${PASSWORDS_PKG}`, bundle: true });
wanted.push({ name: DS_BOT_NAME, spec: dsBotVersion, bundle: false });

for (const { name, spec } of wanted) {
  if (manifest.dependencies[name] !== spec) {
    manifest.dependencies[name] = spec;
    manifestChanged = true;
  }
}

/**
 * Reconcile the bundle layer: keep whatever else is there (base, web-app, and
 * anything the user enabled), and place the bundles this script owns in a stable
 * order right after web-app. ds-bot is deliberately not among them.
 */
const managedBundles = wanted.filter((entry) => entry.bundle).map((entry) => entry.name);
const rest = manifest.dsh.profile.bundles.filter((name) => !managedBundles.includes(name));
const webAppIndex = rest.indexOf('@deepseek-ai/dsh-web-app');
const insertAt = webAppIndex === -1 ? rest.length : webAppIndex + 1;
const desiredBundles = [...rest.slice(0, insertAt), ...managedBundles, ...rest.slice(insertAt)];
if (JSON.stringify(desiredBundles) !== JSON.stringify(manifest.dsh.profile.bundles)) {
  manifest.dsh.profile.bundles = desiredBundles;
  manifestChanged = true;
}

if (manifestChanged) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);
  console.log(`[dsh] profile manifest updated: ${manifestPath}`);
}

// 3) Fill in the sibling files the profile needs, without touching existing ones.
const patchPath = path.join(profileDir, 'cordis.patch.yml');
if (!existsSync(patchPath)) writeFileSync(patchPath, PATCH_TEMPLATE);

const workspacePath = path.join(profileDir, 'pnpm-workspace.yaml');
let workspaceChanged = false;
// Written left-to-right, every call runs (no short-circuit) so all keys land.
workspaceChanged = ensureWorkspaceKey(workspacePath, 'nodeLinker', ['nodeLinker: hoisted']) || workspaceChanged;
workspaceChanged =
  ensureWorkspaceKey(workspacePath, 'autoInstallPeers', ['autoInstallPeers: false']) || workspaceChanged;
workspaceChanged =
  ensureWorkspaceKey(workspacePath, 'allowBuilds', ['allowBuilds:', '  node-pty: true', '  protobufjs: true']) ||
  workspaceChanged;
if (workspaceChanged) console.log(`[dsh] pnpm workspace updated: ${workspacePath}`);

/**
 * The install is done when every wanted package sits at its expected version.
 * This is what makes the step immune to pnpm not exiting: the outcome is read
 * from the filesystem, never from a process exit code.
 */
const stateSatisfied = () =>
  wanted.every(({ name, spec }) => {
    const expected = expectedVersion(spec);
    return expected !== null && readVersion(path.join(profileDir, 'node_modules', name)) === expected;
  });

// 4) Materialize with ONE install (skipped entirely when already consistent).
if (!manifestChanged && !workspaceChanged && stateSatisfied()) {
  console.log('[dsh] web profile plugins already registered');
  process.exit(0);
}

console.log(`[dsh] installing web profile plugins into ${profileDir}`);
const child = spawnPnpm(['install'], profileDir);
if (child === null) {
  console.error('[dsh] pnpm arguments are unsafe; refused');
  process.exit(127);
}

let exited = false;
let exitCode = null;
let exitSignal = null;
child.on('exit', (code, signal) => {
  exited = true;
  exitCode = code;
  exitSignal = signal;
});
child.on('error', (error) => {
  console.error(`[dsh] failed to run pnpm: ${String(error)} (install pnpm and put it on PATH)`);
  exited = true;
  exitCode = 127;
});

/**
 * Terminate an install that finished but will not leave.
 *
 * POSIX: SIGTERM, then SIGKILL if it is still there. Windows: pnpm is launched
 * through cmd.exe, so the process that actually runs pnpm is a grandchild —
 * killing cmd.exe alone would leave it running, hence `taskkill /T`.
 */
async function terminateProcess(child) {
  if (process.platform === 'win32') {
    if (typeof child.pid === 'number') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      await sleep(1000);
    }
    return;
  }
  child.kill('SIGTERM');
  await sleep(2000);
  child.kill('SIGKILL');
  await sleep(200);
}

const deadline = Date.now() + timeoutMs;
let satisfied = false;
while (Date.now() < deadline) {
  if (stateSatisfied()) {
    satisfied = true;
    break;
  }
  if (exited) break;
  await sleep(300);
}

if (satisfied) {
  if (exited) {
    console.log('[dsh] web profile plugins registered');
    process.exit(exitCode === 0 ? 0 : exitCode ?? 0);
  }
  // Finished but still alive: give it a moment to leave on its own, then reap it.
  console.log(`[dsh] install finished but pnpm did not exit; waiting ${Math.round(graceMs / 1000)}s then terminating it`);
  const graceDeadline = Date.now() + graceMs;
  while (!exited && Date.now() < graceDeadline) await sleep(200);
  if (!exited) await terminateProcess(child);
  console.log('[dsh] web profile plugins registered');
  process.exit(0);
}

if (!exited) {
  console.error(`[dsh] pnpm install did not finish within ${Math.round(timeoutMs / 1000)}s; killing it`);
  await terminateProcess(child);
  process.exit(1);
}
console.error(`[dsh] pnpm install failed (exit ${exitCode}${exitSignal === null ? '' : `, signal ${exitSignal}`})`);
process.exit(exitCode === 0 ? 1 : exitCode ?? 1);
