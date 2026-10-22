/**
 * 构建期兼容门禁：dsh-passwords 用字符串锚点给 DSH 客户端 bundle 打「settings 宿主模式」
 * 补丁；网关每次启动都会重新应用并复核这个补丁，复核不过就 fail-closed 拒绝监听 3088。
 *
 * 语义化版本范围（dsh-passwords 声明的 >=0.2.1-alpha.1 <0.2.2-0）不足以保证补丁可用：
 * DSH 0.2.1-rc.2 把 settings 里 `connection.isLoopback ? "host" : "memory"` 这段逻辑
 * 整个重构掉了，dsh-passwords 2.7.8 找不到锚点，于是镜像能构建成功、容器却起不来。
 *
 * 这个脚本在构建期做和网关启动时同样的两件事：应用补丁 → 复核状态；
 * 不兼容就直接让构建失败，并提示改用已验证的 DSH 版本（或用 DSH_SKIP_PATCH_GATE=1
 * 明确跳过，自行承担网关起不来的风险）。
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
  console.error(`${TAG} Fix: drop the DSH_VERSION pin so auto resolution skips incompatible`);
  console.error(`${TAG}      versions, or pin a patch-compatible one (e.g. DSH_VERSION=0.2.1-alpha.2).`);
  console.error(`${TAG}      Alternatively set DSH_SKIP_PATCH_GATE=1 to build anyway, at your own risk.`);
  process.exit(1);
}

console.log(`${TAG} dsh-passwords patch is applicable: ${JSON.stringify(status)}`);
