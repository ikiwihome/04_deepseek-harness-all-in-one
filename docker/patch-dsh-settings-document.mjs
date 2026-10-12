#!/usr/bin/env node
/**
 * Keep the shell from offering "打开配置文件" on a host that cannot open one.
 *
 * 设置 → 通用 → 「打开配置文件」 materializes the profile patch and hands it to the
 * operating system's default text editor. DSH already models that situation —
 * `canOpenNativePath()` in @deepseek-ai/dsh-native-command returns false on a
 * headless or containerised Linux host, with this rationale:
 *
 *   "A headless or containerised Linux host answers false, which is what lets a
 *    surface show a path as text instead of offering a button that would spawn
 *    `xdg-open` into nothing."
 *
 * The settings screen never asks it: `describe()` reports `hasDocument: true`
 * unconditionally, so the browser renders the button (the client only needs
 * `hasDocument` to decide `status: ready | unavailable`), the click runs
 * `xdg-open` inside the container, and the shell shows
 * 「无法打开配置文件」. Both the file and the intent are unreachable: even a
 * successful launch would open an editor on the server, not on the user's screen.
 *
 * So this patch makes that one field tell the truth, and it cannot simply reuse
 * `canOpenNativePath()`: inside a Docker container on Windows the kernel string is
 * `...-microsoft-standard-WSL2`, so `isWsl()` — and with it `canOpenNativePath()`
 * — answers true even though nothing here can reach the desktop of whoever is
 * looking at the browser. The container itself is the reliable fact, hence the
 * `/.dockerenv` (Docker) and `/run/.containerenv` (Podman) markers.
 *
 * The patch is deliberately tiny and fail-loud: if a future DSH version moves
 * either anchor, the build stops instead of shipping a silently unpatched image.
 * On a host that really can open a file and is not a container, the button comes
 * back on its own.
 *
 * Environment:
 *   MCP_DSH_ROOT                     the dsh package root (locates its siblings)
 *   DSH_SETTINGS_CONTROLLER_FILE     explicit file override (tests)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const TAG = '[patch-settings-document]';
const dshRoot = process.env.MCP_DSH_ROOT?.trim() || '/opt/dsh/node_modules/@deepseek-ai/dsh';
const file =
  process.env.DSH_SETTINGS_CONTROLLER_FILE?.trim() ||
  path.join(path.dirname(dshRoot), 'dsh-api-settings-controller', 'lib', 'index.js');

const IMPORT_BEFORE = 'import { openNativeTextFile } from "@deepseek-ai/dsh-native-command";';
const IMPORT_AFTER = 'import { canOpenNativePath, openNativeTextFile } from "@deepseek-ai/dsh-native-command";';
const FIELD_BEFORE = 'hasDocument: true,';
/** `process.getBuiltinModule` keeps this to one line: no new import statement. */
const CONTAINER_MARKERS = '["/.dockerenv", "/run/.containerenv"]';
const FIELD_AFTER =
  `hasDocument: canOpenNativePath() && !${CONTAINER_MARKERS}.some((marker) => process.getBuiltinModule("node:fs").existsSync(marker)),`;

if (!existsSync(file)) {
  console.error(`${TAG} ${file} does not exist; refusing to continue`);
  process.exit(1);
}

const before = readFileSync(file, 'utf8');

if (before.includes(FIELD_AFTER)) {
  console.log(`${TAG} already patched: ${file}`);
  process.exit(0);
}

const missing = [];
if (!before.includes(IMPORT_BEFORE)) missing.push(`import anchor: ${IMPORT_BEFORE}`);
if (!before.includes(FIELD_BEFORE)) missing.push(`field anchor: ${FIELD_BEFORE}`);
if (missing.length > 0) {
  console.error(`${TAG} cannot patch ${file} — the target changed:`);
  for (const entry of missing) console.error(`  - missing ${entry}`);
  console.error(`${TAG} update this patch (docker/patch-dsh-settings-document.mjs) for the new DSH version`);
  process.exit(1);
}

const occurrences = before.split(FIELD_BEFORE).length - 1;
if (occurrences !== 1) {
  console.error(`${TAG} expected exactly one ${JSON.stringify(FIELD_BEFORE)} in ${file}, found ${occurrences}`);
  process.exit(1);
}

const after = before.replace(IMPORT_BEFORE, IMPORT_AFTER).replace(FIELD_BEFORE, FIELD_AFTER);
if (!after.includes(IMPORT_AFTER) || !after.includes(FIELD_AFTER)) {
  console.error(`${TAG} patch verification failed for ${file}`);
  process.exit(1);
}

writeFileSync(file, after, 'utf8');
console.log(`${TAG} patched ${file}: hasDocument now reports whether this host can open a file`);
