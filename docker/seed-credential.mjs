#!/usr/bin/env node
/**
 * Seed the model API key into the harness credential store on first boot.
 *
 * Why this exists: DSH resolves credentials in a fixed precedence — launch
 * environment FIRST, then the stored file (`$DSH_HOME/.credentials.yaml`), then
 * the project/harness `.env` files. A container that always carries
 * `DEEPSEEK_API_KEY` in its environment therefore pins the key forever: anything
 * saved from 设置 → 模型 is shadowed and the field looks read-only.
 *
 * So the environment variable is treated as a first-boot seed only:
 *   1. copy it into the credential store (`refs.DEEPSEEK_API_KEY`), and
 *   2. let the entrypoint drop the variable before `dsh web` starts,
 * after which the settings page is authoritative.
 *
 * An existing stored value is never overwritten — a key the user changed in the
 * GUI wins over the environment seed on every later boot.
 *
 * Exit codes:
 *   0  the store holds the key now (seeded or already present) — the entrypoint
 *      may therefore drop the environment variable;
 *   3  nothing to do: no key in the environment and none stored yet (a fresh
 *      deployment that will be configured from 设置 → 模型);
 *   1  failure — the store could not be written, so the environment variable
 *      must be kept.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const TAG = '[dsh-credential]';
const REF = 'DEEPSEEK_API_KEY';
const key = (process.env[REF] ?? '').trim();

const dshHome = process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh');
const file = process.env.DSH_CREDENTIALS_FILE?.trim() || path.join(dshHome, '.credentials.yaml');

/** The `yaml` package the harness itself uses, resolved from the install root. */
function loadYaml() {
  const dshRoot = process.env.MCP_DSH_ROOT?.trim() || '/opt/dsh/node_modules/@deepseek-ai/dsh';
  try {
    const require = createRequire(path.join(dshRoot, 'package.json'));
    return require('yaml');
  } catch (error) {
    console.warn(`${TAG} cannot load the harness YAML library: ${String(error)}`);
    return null;
  }
}

/**
 * Whether the store already holds a usable value for the reference.
 * Reported through the exit code so the entrypoint knows it may drop the
 * environment variable — a store lookup that was not actually made must never
 * read as success.
 */
function storeHoldsRef(YAML) {
  if (!existsSync(file)) return false;
  try {
    const document = YAML.parseDocument(readFileSync(file, 'utf8'));
    if (Array.isArray(document.errors) && document.errors.length > 0) return false;
    const stored = document.getIn(['refs', REF]);
    return typeof stored === 'string' && stored.trim() !== '';
  } catch {
    return false;
  }
}

if (key === '') {
  const YAML = loadYaml();
  const present = YAML === null ? false : storeHoldsRef(YAML);
  console.log(
    present
      ? `${TAG} no ${REF} in the environment; ${file} already stores it`
      : `${TAG} no ${REF} in the environment and none stored yet; set it in 设置 → 模型`,
  );
  process.exit(present ? 0 : 3);
}

const YAML = loadYaml();
if (YAML === null) {
  console.warn(`${TAG} leaving ${REF} in the environment: the credential store cannot be written safely`);
  process.exit(1);
}

const text = existsSync(file) ? readFileSync(file, 'utf8') : undefined;

let document;
try {
  document = text === undefined ? new YAML.Document({}) : YAML.parseDocument(text);
} catch (error) {
  console.warn(`${TAG} cannot parse ${file}: ${String(error)}`);
  process.exit(1);
}
if (Array.isArray(document.errors) && document.errors.length > 0) {
  console.warn(`${TAG} ${file} is not valid YAML: ${document.errors.map(String).join('; ')}`);
  process.exit(1);
}

const stored = document.getIn(['refs', REF]);
if (typeof stored === 'string' && stored.trim() !== '') {
  console.log(`${TAG} ${file} already stores ${REF}; keeping the stored value`);
  process.exit(0);
}

document.setIn(['version'], 1);
document.setIn(['refs', REF], key);

mkdirSync(path.dirname(file), { recursive: true });
const temporary = `${file}.seed-${process.pid}`;
writeFileSync(temporary, document.toString(), { encoding: 'utf8', mode: 0o600 });
renameSync(temporary, file);
rmSync(temporary, { force: true });
console.log(`${TAG} seeded ${REF} into ${file}`);
process.exit(0);
