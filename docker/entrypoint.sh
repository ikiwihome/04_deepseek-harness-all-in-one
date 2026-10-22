#!/bin/sh
# ---------------------------------------------------------------------------
# DeepSeek Harness 容器入口
#
# 流程（全部幂等，重复启动不会重置任何用户数据）：
#   1. docker-init            —— 生成/沿用网关持久化配置与 SETUP_KEY
#   2. register-web-plugins   —— 一次性注册 profile 插件（一次 pnpm install）
#   3. register-plugin        —— 官方脚本复核 dsh-passwords（状态一致时直接短路）
#   3b. 状态门禁              —— 网关插件没装好就拒绝启动
#   4. patch                  —— 给 DSH 打 dsh-passwords 运行所需补丁
#   5. seed-skins             —— 预置皮肤；默认保持官方原版外观（不激活皮肤）
#   5b. seed-credential       —— 把环境里的模型密钥种进凭据文件，随后丢弃环境变量
#   5c. seed-workspace        —— 写一个默认工作区（/workspace），新建会话无需先选目录
#   6. bootstrap-admin        —— 后台用配置的默认密码自动创建主用户（可选）
#   6b. seed-chat-bubble      —— 后台把 dsh-passwords 的「可拖动聊天气泡」默认关掉
#   7. export HOME=/workspace —— 目录选择器的默认起点
#   8. exec dsh web           —— 启动 DSH Web；网关由 dsh-passwords 插件接管
#
# 第 3b/4 步失败会拒绝启动：没有网关就不该把 DSH 暴露出去。
# 其余步骤失败只告警，容器照常起来。
#
# 密钥可以走环境变量，也可以走文件（*_FILE，推荐：docker inspect 不会显示）：
#   DEEPSEEK_API_KEY_FILE / DSH_ADMIN_PASSWORD_FILE / SETUP_KEY_FILE
# ---------------------------------------------------------------------------
set -eu

# 运行期状态（密钥文件、SQLite 库、审计日志）一律只对属主可读。
umask 077

# 数据目录现在是宿主机 bind mount（默认 $DSH_DATA_DIR，见 docker-compose.yml）。
# Docker 新建的 bind 目录属于 root，命名卷挂载点也一样；这里统一把属主修正为 node，
# 之后所有应用代码都以非特权用户 node 运行。
# chown 失败不再中断启动：从 Windows 盘符 bind 进来时文件系统不保证支持 POSIX 属主，
# 那属于宿主机侧权限问题，给一条可操作的告警比直接拒绝启动更有用。
mkdir -p /data/dsh /data/dsh-passwords /workspace
chown -R node:node /data/dsh /data/dsh-passwords 2>/dev/null \
  || echo "[dsh] warning: could not chown the data dirs; check the host directory ownership" >&2
# /workspace 可能是你自己的目录：只改目录本身，不递归翻里面的数据。
chown node:node /workspace 2>/dev/null \
  || echo "[dsh] warning: could not chown /workspace; the agent may be unable to write there (uid 1000)" >&2
# 早于本次收紧而生成的状态（例如 0644 的 platform.db）一并收口。
chmod -R go-rwx /data/dsh-passwords 2>/dev/null || true
[ -f /data/dsh/.credentials.yaml ] && chmod go-rwx /data/dsh/.credentials.yaml 2>/dev/null || true

# 文件式密钥：给了 *_FILE 就以文件内容为准（去掉行尾换行），并导出给下面的子 shell。
load_secret() {
  variable="$1"
  file="$2"
  [ -n "$file" ] || return 0
  if [ -r "$file" ]; then
    value="$(cat "$file")"
    export "$variable=$value"
    echo "[dsh] $variable loaded from $file"
  else
    echo "[dsh] warning: $variable file is not readable: $file" >&2
  fi
}
load_secret DEEPSEEK_API_KEY "${DEEPSEEK_API_KEY_FILE:-}"
load_secret DSH_ADMIN_PASSWORD "${DSH_ADMIN_PASSWORD_FILE:-}"
load_secret SETUP_KEY "${SETUP_KEY_FILE:-}"

exec su node -s /bin/sh -c '
set -eu
umask 077

PKG="${DSH_PASSWORDS_PKG:-/opt/dsh-passwords/node_modules/dsh-passwords}"
PROFILE_DIR="${DSH_HOME:-/data/dsh}/profiles/web"
PATH="/opt/dsh/node_modules/.bin:/opt/dsh-passwords/node_modules/.bin:$PATH"
export PATH

# 给可能挂起的外部命令加上限：pnpm 11 曾在 prune 路径上出现“打印 Done 后不退出”
# 的挂起，任何一步都不允许无限期卡住启动。
run_bounded() {
  if command -v timeout >/dev/null 2>&1; then
    timeout -k 10 "${DSH_SETUP_TIMEOUT_S:-900}" "$@"
  else
    "$@"
  fi
}

echo "[dsh] dsh $(dsh --version 2>/dev/null || echo unknown) | dsh-passwords $(node "$PKG/dist/cli.js" --version 2>/dev/null || echo unknown)"

# 1) 网关持久化配置 + 首次 SETUP_KEY
node "$PKG/dist/cli.js" docker-init

# 2) 一次把 profile 插件装好：分开装时第二步要 prune 上一次的结果，
#    会踩到上面那种挂起。装好后官方脚本会自己短路，不会再跑 pnpm。
if ! run_bounded node /opt/dsh-setup/register-web-plugins.mjs; then
  echo "[dsh] warning: web profile registration did not finish cleanly; the official script will retry" >&2
fi

# 3) 官方脚本复核 dsh-passwords（状态一致时直接短路）
if ! run_bounded node "$PKG/scripts/register-plugin.mjs"; then
  echo "[dsh] warning: dsh-passwords register-plugin did not finish cleanly" >&2
fi

# 3b) 以结果为准：网关插件没物化、没进 bundle 层就不启动
if [ ! -e "$PROFILE_DIR/node_modules/dsh-passwords" ] || ! grep -q "\"dsh-passwords\"" "$PROFILE_DIR/package.json"; then
  echo "[dsh] FATAL: dsh-passwords is not registered in $PROFILE_DIR; refusing to start." >&2
  exit 1
fi

# 4) 应用 dsh-passwords 的 DSH 补丁（版本门禁不符时这里就会失败）
# profile 持久化目录中的插件是独立副本；每次安装/升级后也要应用登录补丁。
DSH_PASSWORDS_PKG="$PROFILE_DIR/node_modules/dsh-passwords" node /opt/dsh-setup/patch-persistent-login.mjs
if ! node "$PKG/dist/cli.js" patch; then
  echo "[dsh] FATAL: dsh-passwords patch failed; refusing to start." >&2
  exit 1
fi
echo "[dsh] dsh patch applied; starting dsh web."

# 5) 预置皮肤（仅在缺失时写入，绝不覆盖已有状态）。
#    默认 active=null：保持 DSH 官方原版外观，皮肤等用户在「设置 → 皮肤中心」里启用。
node /opt/dsh-setup/seed-skins.mjs

# 5b) 首次启动把环境里的模型密钥种进凭据文件，然后丢掉环境变量。
#     DSH 的凭据优先级是「启动环境 > 凭据文件 > .env」——留着环境变量会让
#     「设置 → 模型」里保存的 key 永远被压住（看起来就是只读）。种进文件后
#     环境变量就不再需要，设置页改的值即生效。
#     退出码：0=库里已有；3=环境里也没有，留给界面配；其它=写失败，保留环境变量。
seed_status=0
node /opt/dsh-setup/seed-credential.mjs || seed_status=$?
case "$seed_status" in
  0)
    unset DEEPSEEK_API_KEY
    echo "[dsh] model credential now comes from the credential store; 设置 → 模型 can change it"
    ;;
  3)
    echo "[dsh] no model key seeded; set it in 设置 → 模型 after signing in"
    ;;
  *)
    echo "[dsh] warning: could not seed the credential store; the launch environment still provides the model key" >&2
    ;;
esac

# 5c) 默认工作区：直接写进工作区注册表，新建会话时不必先让用户选目录。
#     （DSH 的首次工作区在 Linux 上要靠 xdg-user-dir，本镜像没有，所以它跳过了
#      初始化并把 initialized 置为 true，之后不会重试。详见该脚本注释。）
if ! node /opt/dsh-setup/seed-workspace.mjs; then
  echo "[dsh] warning: could not seed a default workspace; the GUI will ask for a directory" >&2
fi

# 6) 首次启动用配置的默认密码自动创建主用户；失败只告警，保留手工配置入口
if [ -n "${DSH_ADMIN_PASSWORD:-}" ]; then
  node /opt/dsh-setup/bootstrap-admin.mjs &
else
  echo "[dsh] DSH_ADMIN_PASSWORD not set: create the first account in the browser with SETUP_KEY"
  echo "[dsh]   SETUP_KEY: docker exec <container> cat /data/dsh-passwords/setup-key.txt"
fi

# 6b) dsh-passwords 的「聊天入口 · 显示可拖动的聊天气泡」默认关闭。
#     它是按用户的显示偏好，存在网关库里；插件对“没有记录”的账号默认为开，
#     所以这里只为还没有显式偏好的账号写默认值（你在界面里改过就永远以你为准）。
#     后台运行：新卷上主账号要等网关起来之后才存在。
node /opt/dsh-setup/seed-chat-bubble.mjs &

# 7) 工作区选择器的默认目录 = /workspace。
#    DSH 的目录选择器在没带路径时列的是 os.homedir()，而它的面包屑只从 home 往下
#    显示（家目录以上的路径被隐藏）——家目录还是 /home/node 时，用户根本走不到
#    /workspace。POSIX 上 os.homedir() 优先读 $HOME，所以这里把 DSH 进程的 HOME
#    指向 /workspace：选择器默认落在 /workspace，agent shell 里的 ~ 也是 /workspace。
#    只影响 dsh web 及其子进程；上面的安装/播种步骤仍用镜像原本的 HOME。
export HOME=/workspace

# 8) 启动 DSH Web（仅回环 3080，由网关 0.0.0.0:3088 对外服务）
exec dsh web --no-open --port "${DSH_WEB_PORT:-3080}"
'
