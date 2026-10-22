# syntax=docker/dockerfile:1
#
# DeepSeek Harness (DSH) — 本地/内网自托管镜像
#
#   内置：@deepseek-ai/dsh（DSH 本体，Web profile）
#   预装并启用（每个 profile 都在首次启动时自动注册，幂等）：
#     1. dsh-passwords                              密码登录网关（唯一对外入口）
#     2. @linxin666/dsh-client-ui-skin-center       皮肤管理中心
#     3. skins/whale-fantasy                        皮肤本体（已预置为默认皮肤）
#
# 端口模型（单容器）：
#   * 容器内 dsh web 只监听回环 127.0.0.1:3080（DSH 官方硬性拒绝通配绑定），
#     不对外暴露；
#   * dsh-passwords 网关监听 0.0.0.0:3088，是唯一对外端口，由它反代 dsh web、
#     提供登录/账号/权限。
#   因此只需对外发布 3088 即可（nginx 反代请指向它，需支持 WebSocket）。
#
# 官方配方出处：dsh-passwords@2.7.8 的 docker/Dockerfile.bundled（已按需改写为
# 从 npm 安装已发布的 dist，而不是在镜像内从 git 源码构建）。

FROM node:22.19.0-slim

# ---------------------------------------------------------------------------
# 版本参数（构建期）：默认全部 `latest` = 跟随 npm 最新，重建镜像即自动升级。
#   DSH_VERSION / DSH_PASSWORDS_VERSION / SKIN_CENTER_VERSION
#       传具体版本号即钉死（例如 SKIN_CENTER_VERSION=0.4.4）。
#       DSH 不是取 npm 的 `latest` 标签——那个标签当前指向 0.2.0-rc.2，会被
#       dsh-passwords 拒绝；而是用 dsh-passwords 自己声明的兼容范围
#       （>=0.2.1-alpha.1 <0.2.2-0）解析出范围内最新的版本。
#   REFRESH
#       解析这一步会被 Docker 层缓存；想强制重新解析时传任意新值
#       （compose 里对应 DSH_REFRESH），例如 DSH_REFRESH=$(date +%s)。
#   PNPM_VERSION
#       pnpm 是构建/安装工具，不是上面那三个组件；默认跟随 latest。
#       注意 pnpm 大版本会改变 allowBuilds 语义，构建末尾有原生模块断言兜底。
# ---------------------------------------------------------------------------
ARG PNPM_VERSION=latest

# ---------------------------------------------------------------------------
# 1) 基础工具 + pnpm（DSH profile 的插件安装器）
#    构建期要拉 1000+ 个包，给 npm/pnpm 加上重试与更长超时，避免一次网络抖动
#    就让整个构建失败（ECONNRESET 是这里实际遇到过的情况）。
# ---------------------------------------------------------------------------
RUN apt-get update \
  && apt-get install -y --no-install-recommends nano ca-certificates git python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN npm config set fetch-retries 5 \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 120000 \
  && npm config set fetch-timeout 600000 \
  && npm install -g "pnpm@${PNPM_VERSION}" \
  && pm="$(command -v pnpm)" \
  && "$pm" config set fetch-retries 5 \
  && "$pm" config set fetch-timeout 600000 \
  && echo "pnpm $(pnpm --version)"

# ---------------------------------------------------------------------------
# 2) 解析四个组件当前最新且互相兼容的版本（写 /opt/dsh-versions.json/.env）
#    注意：compose 里传的每个构建参数都必须在这里有一个同名 ARG——未被 ARG 声明
#    的参数不会进入 RUN 步骤的环境，于是会被静默忽略（曾经 DS_BOT_VERSION 就是
#    这样：传了也钉不住版本）。tests/build-config.test.mjs 会守住这条。
# ---------------------------------------------------------------------------
COPY docker/resolve-versions.mjs /opt/dsh-setup/resolve-versions.mjs
ARG REFRESH=0
ARG DSH_VERSION=latest
ARG DSH_PASSWORDS_VERSION=latest
ARG SKIN_CENTER_VERSION=latest
ARG DS_BOT_VERSION=latest
RUN echo "[resolve-versions] refresh=${REFRESH}" \
  && node /opt/dsh-setup/resolve-versions.mjs \
  && cat /opt/dsh-versions.json

# ---------------------------------------------------------------------------
# 3) 把 DSH 本体安装成“bundled”布局：/opt/dsh/node_modules/@deepseek-ai/dsh
#    allowBuilds 是 dsh 原生依赖（node-pty / koffi / protobufjs …）所必需的，
#    与官方 bundled 配方一致。
#    注意：这里用 RESOLVED_* 而不是 DSH_VERSION —— Docker 会在 shell 之前用
#    ARG（默认值为 latest）展开 RUN 里的 ${DSH_VERSION}，同名会互相覆盖。
# ---------------------------------------------------------------------------
RUN set -a && . /opt/dsh-versions.env && set +a \
  && mkdir -p /opt/dsh \
  && printf '%s\n' '{"name":"bundled-dsh","private":true}' > /opt/dsh/package.json \
  && printf '%s\n' \
       'packages:' \
       '  - .' \
       'nodeLinker: hoisted' \
       'allowBuilds:' \
       '  "@deepseek-ai/dsh-subprocess-local": true' \
       '  "@google/genai": true' \
       '  koffi: true' \
       '  node-pty: true' \
       '  protobufjs: true' \
       > /opt/dsh/pnpm-workspace.yaml \
  && pnpm --dir /opt/dsh add "@deepseek-ai/dsh@${RESOLVED_DSH_VERSION}" \
  && node -e "const v=require('/opt/dsh/node_modules/@deepseek-ai/dsh/package.json').version; if (v !== process.env.RESOLVED_DSH_VERSION) { console.error('bundled DSH mismatch: '+v+' != '+process.env.RESOLVED_DSH_VERSION); process.exit(1); } console.log('bundled DSH '+v);" \
  && node -e "const fs=require('node:fs');const p='/opt/dsh/node_modules/node-pty/prebuilds/linux-x64/pty.node';if(!fs.existsSync(p)){console.error('node-pty linux prebuild missing: did pnpm ignore allowBuilds?');process.exit(1);}console.log('node-pty prebuild present');" \
  && echo "native dependency install scripts ran"

# ---------------------------------------------------------------------------
# 3b) 补一个上游遗漏的守卫：容器里没有桌面，就不该显示「打开配置文件」。
#     DSH 自己有 canOpenNativePath()（无桌面/容器返回 false），但它那个按钮没调用，
#     于是点击后容器里执行 xdg-open 失败，界面提示「无法打开配置文件」。
#     这个补丁只让 describe() 的 hasDocument 如实回答；补丁锚点变了会让构建失败，
#     而不是悄悄漏打。详见 docker/patch-dsh-settings-document.mjs。
# ---------------------------------------------------------------------------
COPY docker/patch-dsh-settings-document.mjs /opt/dsh-setup/patch-dsh-settings-document.mjs
RUN node /opt/dsh-setup/patch-dsh-settings-document.mjs

# ---------------------------------------------------------------------------
# 4) dsh-passwords（已发布的 dist + scripts，官方 npm 包）
#    只需要 dist/cli.js 与 scripts/register-plugin.mjs、scripts/docker-init.mjs；
#    全部为已构建产物，镜像内无需再跑 TypeScript 构建。
# ---------------------------------------------------------------------------
WORKDIR /opt/dsh-passwords
RUN set -a && . /opt/dsh-versions.env && set +a \
  && printf '%s\n' '{"name":"dsh-passwords-runtime","private":true}' > package.json \
  && npm install --no-audit --no-fund "dsh-passwords@${RESOLVED_DSH_PASSWORDS_VERSION}" \
  && node -e "const p=require('/opt/dsh-passwords/node_modules/dsh-passwords/package.json'); if (p.version !== process.env.RESOLVED_DSH_PASSWORDS_VERSION) { console.error('dsh-passwords mismatch: '+p.version+' != '+process.env.RESOLVED_DSH_PASSWORDS_VERSION); process.exit(1); } console.log('dsh-passwords '+p.version);" \
  && node -e "const v=require('/opt/dsh/node_modules/@deepseek-ai/dsh/package.json').version; const r=require('/opt/dsh-versions.json').dshRange; console.log('DSH '+v+' | dsh-passwords gate '+r);"

# ---------------------------------------------------------------------------
# 4b) dsh-passwords 补丁兼容门禁
#     网关启动时会用字符串锚点给 DSH 客户端 bundle 打「settings 宿主模式」补丁，
#     并复核结果；复核不过就 fail-closed 拒绝监听 3088。语义化版本范围挡不住上游重构：
#     DSH 0.2.1-rc.2 把那段 settings 逻辑整个改写了，补丁打不上，镜像能构建成功、
#     容器却起不来。这里在构建期应用并复核同一个补丁，不兼容直接构建失败，
#     并提示改用已验证的 DSH 版本（例如 DSH_VERSION=0.2.1-alpha.2）。
#     确认要跳过（自行承担网关起不来的风险）时用 --build-arg DSH_SKIP_PATCH_GATE=1。
# ---------------------------------------------------------------------------
COPY docker/check-patch-compat.mjs /opt/dsh-setup/check-patch-compat.mjs
ARG DSH_SKIP_PATCH_GATE=0
RUN if [ "$DSH_SKIP_PATCH_GATE" = "1" ]; then \
      echo "[patch-compat-gate] skipped by DSH_SKIP_PATCH_GATE=1"; \
    else \
      node /opt/dsh-setup/check-patch-compat.mjs; \
    fi

# ---------------------------------------------------------------------------
# 5) 本镜像自带的启动/初始化脚本、默认值 bundle、皮肤种子
#    skins/whale-fantasy 与上游 https://github.com/zhu1090093659/dsh-skins
#    的 dsh-skins/skins/whale-fantasy 一致（含 LICENSE，CC BY-NC-SA 4.0）。
#    docker/defaults 是一个 bundle 层，给出“开箱默认”（浅色主题等），
#    位于用户自己的 profile patch 之下，所以 GUI 里改过的设置永远优先。
# ---------------------------------------------------------------------------
COPY docker/entrypoint.sh /usr/local/bin/dsh-entrypoint
COPY docker/register-web-plugins.mjs /opt/dsh-setup/register-web-plugins.mjs
COPY docker/seed-skins.mjs /opt/dsh-setup/seed-skins.mjs
COPY docker/seed-credential.mjs /opt/dsh-setup/seed-credential.mjs
COPY docker/seed-workspace.mjs /opt/dsh-setup/seed-workspace.mjs
COPY docker/bootstrap-admin.mjs /opt/dsh-setup/bootstrap-admin.mjs
COPY docker/seed-chat-bubble.mjs /opt/dsh-setup/seed-chat-bubble.mjs
COPY docker/defaults /opt/dsh-defaults
COPY skins/whale-fantasy /opt/dsh-seed/skins/whale-fantasy
COPY docker/skin-center-active.json /opt/dsh-seed/skin-center-active.json

RUN sed -i 's/\r$//' /usr/local/bin/dsh-entrypoint \
  && chmod 755 /usr/local/bin/dsh-entrypoint \
  && mkdir -p /data/dsh /data/dsh-passwords /workspace \
  && chown -R node:node /opt/dsh /opt/dsh-passwords /opt/dsh-setup /opt/dsh-defaults /opt/dsh-seed /data /workspace

# ---------------------------------------------------------------------------
# 5b) 文档预览字体（右侧预览 Word/PPT 的前提）
#     Linux 上没有原生 LibreOffice 引擎包，Office 转 PDF 走 kit 的 WASM 引擎；
#     它只直接从磁盘索引字体文件，一个可用字体都找不到就直接失败：
#       ConversionError code=unavailable / "No usable fonts were found"
#     表现为右侧打开 .doc/.docx/.ppt/.pptx 显示
#     「Office 预览不可用。请在运行 DeepSeek Harness 的主机上启用文档预览服务。」
#     node:*-slim 基础镜像里没有任何字体，所以必须显式安装：
#       - fonts-noto-cjk               中文/日文/韩文文档正常排版（中文文档必需）
#       - fonts-dejavu-core           拉丁文基础字体
#       - fonts-liberation            Arial/Times/Courier 的度量兼容替代，
#                                     减少「缺失字体」提示、贴近原版排版
#       - fontconfig                  统一重建字体缓存，便于 fc-list 排查
#     字体装在 apt 层；PDF 与 Excel 是浏览器内渲染，不依赖这里。
# ---------------------------------------------------------------------------
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       fontconfig \
       fonts-dejavu-core \
       fonts-liberation \
       fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/* \
  && test -n "$(find /usr/share/fonts -type f \( -name '*.ttf' -o -name '*.ttc' -o -name '*.otf' \) -print -quit)" \
  && echo "office preview fonts installed: $(find /usr/share/fonts -type f | wc -l) font files"

# ---------------------------------------------------------------------------
# 6) 运行期环境
#    三个组件的实际版本不在这里写死：构建期的解析结果在 /opt/dsh-versions.json，
#    运行期由 register-web-plugins.mjs 读取。
#    DSH_PERMISSION_MODE=danger-full-access 是 DSH 自己的沙箱/审批开关：
#      沙箱模式 → danger-full-access，审批 → never（默认完全权限）。
#    DSH_SKIN_ID 故意不设：默认保持官方原版外观，皮肤由用户在界面里启用。
# ---------------------------------------------------------------------------
ENV PATH=/opt/dsh/node_modules/.bin:/opt/dsh-passwords/node_modules/.bin:${PATH} \
    DSH_HOME=/data/dsh \
    DSH_PASSWORDS_PKG=/opt/dsh-passwords/node_modules/dsh-passwords \
    DSH_PASSWORDS_ENV_FILE=/data/dsh-passwords/.env \
    DSH_PASSWORDS_RUNTIME=docker \
    MCP_DSH_ROOT=/opt/dsh/node_modules/@deepseek-ai/dsh \
    MCP_DB_PATH=/data/dsh-passwords/platform.db \
    MCP_GATEWAY_AUTO_TLS=0 \
    MCP_GATEWAY_HOST=0.0.0.0 \
    MCP_GATEWAY_PORT=3088 \
    MCP_GATEWAY_UPSTREAM=http://127.0.0.1:3080 \
    MCP_DSH_RESTART_SERVICE= \
    DSH_WEB_PORT=3080 \
    DSH_VERSIONS_JSON=/opt/dsh-versions.json \
    DSH_DEFAULTS_PKG=/opt/dsh-defaults \
    DSH_PERMISSION_MODE=danger-full-access

# ---------------------------------------------------------------------------
# 默认登录密码（可选）：
#   在这里写死一个默认值，或在 docker-compose.yml / --env-file 里用
#   DSH_ADMIN_PASSWORD 覆盖（compose 的优先级更高）。留空则跳过自动建号，
#   改为浏览器首次访问时用 SETUP_KEY 手工创建第一个用户。
#   密码策略（dsh-passwords 强制）：>=12 位且含大写、小写、数字、符号，<=72 字节。
# ENV DSH_ADMIN_USERNAME=admin
# ENV DSH_ADMIN_PASSWORD=ChangeMe@2026!

EXPOSE 3088

# dsh web 以工作目录作为默认 workspace 根目录
WORKDIR /workspace

# 就绪探针：数据库不可用时 /gateway/readyz 返回 503；首次启动要装插件并打补丁，
# 用较长的 start-period 避免启动阶段被误判为不健康。
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_GATEWAY_PORT||'3088')+'/gateway/readyz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dsh-entrypoint"]
