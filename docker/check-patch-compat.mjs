/**
 * Build-time gateway verification for the selected latest DSH.
 * Native Host settings implementations are recognized by patch-passwords-native-settings.mjs;
 * older DSH still receives the upstream host-mode patch. Cookie bridge checks remain mandatory.
 * Unknown implementations fail clearly instead of silently downgrading DSH.
 */
import { existsSync } from "node:fs";
import {
  applyRemotePatch,
  patchStatus,
} from "/opt/dsh-passwords/node_modules/dsh-passwords/dist/patch.js";

const TAG = "[patch-compat-gate]";
const dshRoot = "/opt/dsh/node_modules/@deepseek-ai/dsh";

if (!existsSync(dshRoot)) {
  console.error(`${TAG} DSH root not found: ${dshRoot}`);
  process.exit(1);
}

let applied;
try {
  applied = applyRemotePatch(dshRoot);
} catch (error) {
  console.error(`${TAG} applying the dsh-passwords patch threw:`, error);
  process.exit(1);
}

const status = patchStatus(dshRoot);
const bridgeOk = status.connectionCookieBridge === "patched" || status.connectionCookieBridge === "native";
if (!status.settingsHostMode || !bridgeOk) {
  console.error(`${TAG} this DSH build is NOT compatible with the bundled dsh-passwords:`);
  console.error(`${TAG}   applyRemotePatch -> ${applied}`);
  console.error(`${TAG}   patchStatus -> ${JSON.stringify(status)}`);
  console.error(`${TAG} DSH refactored the client bundle these anchors match; the gateway would`);
  console.error(`${TAG} refuse to start (settings host-mode patch missing/unsupported).`);
  console.error(`${TAG} Update the gateway adapter for the selected DSH version. DSH will not be automatically downgraded.`);
  process.exit(1);
}

console.log(`${TAG} dsh-passwords patch is applicable: ${JSON.stringify(status)}`);
