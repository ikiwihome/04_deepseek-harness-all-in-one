import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageName = '@linxin666/dsh-client-ui-skin-center';
const nodeDir = path.dirname(process.execPath);
const npmCli = [
  path.join(nodeDir, 'node_modules/npm/bin/npm-cli.js'),
  path.join(nodeDir, '../lib/node_modules/npm/bin/npm-cli.js')
].find(existsSync);
if (!npmCli) throw new Error('npm runtime not found');
const semver = createRequire(npmCli)('semver');

export function selectCompatibleSkin({ dsh, versions, pinned, metadata }) {
  const candidates = pinned ? [pinned] : [...new Set(versions)].filter(v => semver.valid(v) && !semver.prerelease(v)).sort(semver.rcompare);
  for (const version of candidates) {
    const manifest = metadata(version);
    if (!manifest || manifest.version !== version) throw new Error(`Cannot read ${packageName}@${version} metadata`);
    const range = manifest.peerDependencies?.['@deepseek-ai/dsh'];
    if (!range || semver.satisfies(dsh, range, { includePrerelease: true })) return version;
    if (pinned) throw new Error(`${packageName}@${version} requires dsh ${range}, but this image uses ${dsh}; choose a compatible version`);
    console.log(`[skin-compat] skip ${version}: requires dsh ${range}, selected ${dsh}`);
  }
  throw new Error(`No compatible ${packageName} release for dsh ${dsh}`);
}

function npmView(spec, field) {
  const output = execFileSync(process.execPath, [npmCli, 'view', spec, ...(field ? [field] : []), '--json'], { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  const result = JSON.parse(output);
  return Array.isArray(result) && !field ? result.at(-1) : result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const jsonFile = process.env.DSH_VERSIONS_JSON || '/opt/dsh-versions.json';
  const envFile = process.env.DSH_VERSIONS_ENV || '/opt/dsh-versions.env';
  const versions = JSON.parse(readFileSync(jsonFile, 'utf8'));
  const requested = process.env.SKIN_CENTER_VERSION?.trim();
  const pinned = requested && !['latest', 'none'].includes(requested) ? requested : undefined;
  const skin = selectCompatibleSkin({
    dsh: versions.dsh, pinned,
    versions: pinned ? [] : npmView(packageName, 'versions'),
    metadata: version => npmView(`${packageName}@${version}`)
  });
  versions.skinCenter = skin;
  versions.skinCenterResolution = pinned ? 'pinned-compatible' : 'newest-peer-compatible';
  writeFileSync(jsonFile, JSON.stringify(versions, null, 2) + '\n');
  const env = readFileSync(envFile, 'utf8');
  if (!/^RESOLVED_SKIN_CENTER_VERSION=.*$/m.test(env)) throw new Error('skin version env entry missing');
  writeFileSync(envFile, env.replace(/^RESOLVED_SKIN_CENTER_VERSION=.*$/m, `RESOLVED_SKIN_CENTER_VERSION=${skin}`));
  console.log(`[skin-compat] ${packageName}@${skin} compatible with dsh ${versions.dsh}`);
}
