#!/usr/bin/env node
/** DSH wins: resolve its latest npm tag first, then validate dependent components. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const nodeDir = path.dirname(process.execPath);
const npmCli = [path.join(nodeDir, 'node_modules/npm/bin/npm-cli.js'), path.join(nodeDir, '../lib/node_modules/npm/bin/npm-cli.js')].find(existsSync);
if (!npmCli) throw new Error('npm runtime not found');
const semver = createRequire(npmCli)('semver');
const packages = { dsh: '@deepseek-ai/dsh', dshPasswords: 'dsh-passwords', skinCenter: '@linxin666/dsh-client-ui-skin-center', dsBot: 'ds-bot' };

function npmView(spec, field) {
  const raw = execFileSync(process.execPath, [npmCli, 'view', spec, field, '--json'], { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  if (!raw.trim()) return null;
  const value = JSON.parse(raw);
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

export function resolveBuildVersions({ env = process.env, view = npmView } = {}) {
  const resolve = (name, variable) => {
    const requested = env[variable]?.trim();
    const pinned = requested && !['latest', 'none'].includes(requested);
    if (pinned && !semver.valid(requested)) throw new Error(`${variable} must be latest or a concrete version`);
    const version = view(`${name}@${pinned ? requested : 'latest'}`, 'version');
    if (!semver.valid(version)) throw new Error(`Could not resolve ${name} version`);
    if (pinned && version !== requested) throw new Error(`${name} version mismatch`);
    return version;
  };
  // Never constrain DSH to a plugin range, exclude rc, or roll it back for patch anchors.
  const dsh = resolve(packages.dsh, 'DSH_VERSION');
  const dshPasswords = resolve(packages.dshPasswords, 'DSH_PASSWORDS_VERSION');
  let dshRange;
  for (const field of ['peerDependencies', 'devDependencies', 'dependencies']) {
    const value = view(`${packages.dshPasswords}@${dshPasswords}`, field);
    if (typeof value?.[packages.dsh] === 'string') { dshRange = value[packages.dsh]; break; }
  }
  if (!dshRange || !semver.satisfies(dsh, dshRange, { includePrerelease: true })) {
    throw new Error(`Selected latest DSH ${dsh} is outside dsh-passwords ${dshPasswords} range ${dshRange ?? '(undeclared)'}. Update the gateway; DSH will not be silently downgraded.`);
  }
  return {
    resolvedAt: new Date().toISOString(), dsh, dshPasswords,
    // Final skin peer validation/selection runs in resolve-skin-version.mjs.
    skinCenter: resolve(packages.skinCenter, 'SKIN_CENTER_VERSION'),
    dsBot: resolve(packages.dsBot, 'DS_BOT_VERSION'), dshRange,
    dshResolution: env.DSH_VERSION && !['latest', 'none'].includes(env.DSH_VERSION.trim()) ? 'pinned' : 'latest-tag',
    versionPriority: 'dsh-first'
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const versions = resolveBuildVersions();
  const jsonFile = process.env.DSH_VERSIONS_JSON?.trim() || '/opt/dsh-versions.json';
  const envFile = process.env.DSH_VERSIONS_ENV?.trim() || '/opt/dsh-versions.env';
  mkdirSync(path.dirname(jsonFile), { recursive: true });
  mkdirSync(path.dirname(envFile), { recursive: true });
  writeFileSync(jsonFile, JSON.stringify(versions, null, 2) + '\n');
  writeFileSync(envFile, [
    `RESOLVED_DSH_VERSION=${versions.dsh}`, `RESOLVED_DSH_PASSWORDS_VERSION=${versions.dshPasswords}`,
    `RESOLVED_SKIN_CENTER_VERSION=${versions.skinCenter}`, `RESOLVED_DS_BOT_VERSION=${versions.dsBot}`, ''
  ].join('\n'));
  console.log('[resolve-versions] DSH-first latest policy', JSON.stringify(versions));
}
