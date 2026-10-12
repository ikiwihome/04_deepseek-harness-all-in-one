# DeepSeek Harness 本地/内网自托管（Docker）

一个 Dockerfile + docker-compose，把 **最新版 DSH Web** 直接跑起来，并预装启用：

| 组件 | 版本 | 作用 |
|---|---|---|
| `@deepseek-ai/dsh` | `0.2.1-alpha.2` | DSH 本体（web profile） |
| `dsh-passwords` | `2.7.8` | 密码登录网关：唯一对外入口，账号/权限/配额/审计 |
| `@linxin666/dsh-client-ui-skin-center` | `0.4.4` | 皮肤管理中心（设置 → 皮肤中心） |
| `skins/whale-fantasy` | `1.0.0` | 鲸鱼娘·未至之境（视频背景皮肤），已预置并**默认启用** |

对外只暴露 **3088** 一个端口，nginx 直接反代它即可。

---

## 1. 端口模型

```
浏览器 ──> 容器 0.0.0.0:3088   dsh-passwords 网关（登录 / Cookie / 反代）
                                   │  127.0.0.1:3080（容器内回环）
                                   └─> dsh web（DSH 官方硬性拒绝通配绑定，
                                                所以它只监听回环，不对外）
```

* **3088 = 唯一对外端口**。登录、会话、皮肤静态资源、WebSocket 全走这里。
* 3080 只在容器内可达，不需要也不应该映射出去。
* 因此 `ports` 只需发布 3088，nginx 反代指向它。

---

## 2. 快速开始

```bash
cp .env.example .env
# 编辑 .env：填 DEEPSEEK_API_KEY，按需改 DSH_ADMIN_PASSWORD
docker compose up -d --build
```

打开 `http://<宿主机地址>:3088` → 用 `.env` 里的 `DSH_ADMIN_USERNAME` /
`DSH_ADMIN_PASSWORD` 登录。

开箱默认（详见第 3 节）：**官方原版外观 + 浅色主题**、
**模型 Key 可在「设置 → 模型」里替换**（`.env` 里的值只作首次种子）、
**默认完全权限**、**ds-bot 已安装但未启用**。

> 首次构建会下载 DSH 及其依赖（含 node-pty / koffi 等原生模块），需要几分钟；
> 首次启动装插件（镜像内已预热 pnpm store，通常几秒）→ 打补丁 → 建号，
> 之后网关就绪。`docker compose logs -f dsh` 可以看全过程。

> 🔐 `.env` 里有明文密钥与密码，**不要入库**（仓库已带 `.gitignore`，`.dockerignore`
> 也不会把它打进镜像）。如果曾经提交过，历史里仍然拿得到，请轮换密钥。

### 默认密码怎么配

“默认密码”就是 `.env`（或 `docker-compose.yml`，或 Dockerfile 里的 `ENV`）中的：

```dotenv
DSH_ADMIN_USERNAME=admin
DSH_ADMIN_PASSWORD=ChangeMe@2026!
```

容器启动时会调用网关自身的首次配置接口（`POST /gateway/setup`，与浏览器表单
同一套 CSRF 双提交契约）自动创建主用户，所以你不需要手工过一遍网页初始化。

* 密码策略（插件强制）：**≥12 位，且大写/小写/数字/符号各至少一个，≤72 字节**。
  不满足时容器仍会启动，日志会说明原因，你改用网页 + `SETUP_KEY` 手工建号。
* 只在**平台尚未初始化**时生效；改这里的值**不会**重置已有账号，
  改密码请登录后在设置页操作（或删掉数据卷重来，见第 7 节）。
* 不想在文件里写明文密码：留空 `DSH_ADMIN_PASSWORD`，改为首次访问网页时用
  `SETUP_KEY` 手工建号；`SETUP_KEY` 留空则由容器随机生成，用
  `docker exec dsh cat /data/dsh-passwords/setup-key.txt` 读取。
* 也支持 Docker secret：`DSH_ADMIN_PASSWORD_FILE=/run/secrets/xxx`。

> ⚠️ 默认值 `ChangeMe@2026!` 是公开的。**对外暴露前务必改掉**，或者干脆把
> `DSH_ADMIN_PASSWORD` 留空、走 `SETUP_KEY` 手工建号。

### 只在安全性更高的场景下才需要的变量（见 `.env.example`）

`MCP_GATEWAY_PUBLIC_HOST`（反代域名，防 Host 伪造）、
`MCP_GATEWAY_DIRECTORY_PICKER_ROOTS`（子用户可读目录的浏览起点，默认 `/workspace`）、
`SETUP_KEY`、`MCP_JWT_SECRET`、`MCP_INTERNAL_SECRET`。

---

## 3. 开箱默认：官方外观、可改的 Key、完全权限、ds-bot 待启用

### 3.1 外观：官方默认浅色，皮肤由你自己开

* **主题**：默认 DSH 官方默认的**浅色**主题。它来自镜像里的
  `dsh-local-defaults` bundle（[docker/defaults/cordis.patch.yml](docker/defaults/cordis.patch.yml)），
  这是一个**位于你 profile patch 之下**的 patch 层——在「设置 → 外观」里改过之后，
  界面写进 profile 的值会覆盖它，这里的默认值不会再回弹。
* **皮肤**：默认**不激活任何皮肤**，也就是官方原版外观。
  `whale-fantasy` 仍然预装在 `/data/dsh/skins/whale-fantasy`
  （来自 [zhu1090093659/dsh-skins](https://github.com/zhu1090093659/dsh-skins)，
  含 LICENSE 署名），在「设置 → 皮肤中心」里点一下即可启用，无需重启。
* active 状态写在 `$DSH_HOME/skin-center-active.json`：

  ```json
  { "active": null, "initialized": true, "background": { … } }
  ```

  `initialized: true` 是刻意的：皮肤中心在未初始化时会自动启用它自带的内置皮肤
  （blue-fantasy），标记成已初始化才能保持官方原版外观。
  `background` 段是 whale-fantasy 的观感参数（遮挡 35%、输入卡模糊 4px、气泡 20%），
  等你启用皮肤后生效，之后可在皮肤中心里实时调。
* **幂等且不覆盖**：已存在的皮肤目录或 active 文件一律不覆盖，所以重启容器或在
  界面里换皮肤都不会被重置。想开箱就激活某个皮肤，设 `DSH_SKIN_ID=<id>`。
* 皮肤目录可用 `DSH_SKINS_HOME` / `DSH_SKINS_DIR` 覆盖（active 文件会跟着走）。

### 3.2 模型 Key：启动时是种子，之后在「设置 → 模型」里改

DSH 的凭据优先级是 **启动环境变量 > 凭据文件 > .env**。如果容器一直带着
`DEEPSEEK_API_KEY` 环境变量，那么设置在界面里保存的 key 永远被压住（看起来就是只读）。
所以本镜像把它当作**一次性的种子**：

1. 首次启动把环境里的 key 写进凭据文件 `/data/dsh/.credentials.yaml`
   （`refs.DEEPSEEK_API_KEY`，`version: 1`，保留其它记录）；
2. 然后**丢掉这个环境变量**再启动 `dsh web`。

之后「设置 → 模型」里保存的值就是唯一来源，改完立即生效、重启不丢。
想换 key 也可以直接改那个文件（它是 `0600` 的 YAML）。
把凭据文件里的值删掉再重启，容器会用 `.env` 里的值重新播种。

> 文件权限挡不住 agent 本身：工具进程以同一个 `node` 用户运行，所以凭据文件对
> agent 是可读的（DSH 自己的文档也这么说明）。要隔离 provider key，需要用别的
> 凭据后端，而不是文件权限。

### 3.3 权限：默认完全权限

DSH 自己的开关 `DSH_PERMISSION_MODE`：

* `danger-full-access`（本镜像默认）→ 沙箱 `danger-full-access` + 审批 `never`；
* 未设置时 DSH 的默认是 `workspace-write`（写操作只允许工作区内，且需要审批）。

想收紧就改 compose 的 `DSH_PERMISSION_MODE`（如 `workspace-write`），
或在界面「权限」里切换预设。

### 3.4 ds-bot：已安装，默认不启用

[ds-bot](https://github.com/FeiZhuLulu/DeepSeek-Bot)（`ds-bot@0.1.2`）会被装进
profile 的 `node_modules`，但**不进 bundle 层**——DSH 不会加载它，启动的配置树里
也看不到它。启用方式：**设置 → 插件**里打开（或把 `ds-bot` 加进
`/data/dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 后重启）。
本仓库的启动脚本不会把它移除，你启用后的状态会保留。

> 它作为普通依赖跟随最新版本解析（见第 4 节 `DS_BOT_VERSION`）。

### 3.5 工作区目录：选择器默认落在 /workspace

DSH 的目录选择器在**不带路径打开时列的是 `os.homedir()`**，而它的面包屑**只从 home
往下显示**（家目录以上的路径被隐藏）。容器里 node 用户的家目录是 `/home/node`，所以
不处理的话：选择器打开就是空的 `/home/node`，而且**根本走不到 `/workspace`**。

处理办法：容器在启动 `dsh web` 之前把 **`HOME` 指向 `/workspace`**（POSIX 上
`os.homedir()` 优先读 `$HOME`）。于是：

* 选择“工作区目录”时默认就在 `/workspace`，可以直接确认或往下选子目录；
* agent shell 里的 `~` 也是 `/workspace`（与工作区一致，符合直觉）；
* 只影响 `dsh web` 及其子进程（网关、agent shell、`docker exec` 之外的运行期组件）；
  上面的插件安装与播种步骤仍用镜像原本的 `HOME`，pnpm store 之类不会挪进工作区。

工作区的挂载点本来就是 `/workspace`（compose 里 `${DSH_DATA_DIR}/workspace` 的 bind mount），
`WORKDIR` 也是它，所以新会话的工作目录同样是 `/workspace`。

### 3.6 新建会话不再要求先选目录：默认工作区已存在

DSH 的“首次工作区”是从系统 **Documents 目录**推导的；Linux 上这一步要调用
`xdg-user-dir DOCUMENTS`，而本镜像没有这个命令，于是初始化被跳过——但注册表仍被写成
`initialized: true`、`workspaceIds: []`，**之后每次启动都不会再重试**，界面只能让用户
自己去选一个目录。

所以容器启动时会直接把这个默认工作区写进注册表
（[docker/seed-workspace.mjs](docker/seed-workspace.mjs)），用的是 DSH 自己的
`workspace` domain 存储格式（unit `{name: workspace, version: 2}` + global + `workspaces` 表）：

```json
{
  "global": { "initialized": true, "workspaceIds": ["<id>"] },
  "tables": { "workspaces": { "<id>": {
    "path": "/workspace", "title": "default-workspace",
    "sessionIds": [], "createdAt": "…", "updatedAt": "…" } } }
}
```

* `path` 取 `fs.realpath` 后的 `/workspace`，和 DSH 自己创建时一致；
* `title: "default-workspace"` 是 DSH 给自己的自动默认工作区用的名字段，
  界面会按语言显示成「默认工作区」而不是裸目录名。
* **只在注册表里一个工作区都没有时才写**：你自己建过的工作区永远不会被覆盖或追加；
  存储文件读不懂时也原样不动（绝不阻塞启动）。

效果：登录后新建会话直接就有那个默认工作区，不需要先选目录。

### 3.7 「可拖动的聊天气泡」默认关闭

设置里 dsh-passwords 的「**聊天入口 · 显示可拖动的聊天气泡**」是它自己的**按用户**
显示偏好，存在网关库的 `platform_settings` 里：

```
chat_enabled:<userId> = '1' | '0'
```

而插件对**没有记录**的账号是**默认开启**（`getSetting(...) !== '0'`）——这就是新部署
凭空多出那个悬浮气泡的原因。

镜像的处理（[docker/seed-chat-bubble.mjs](docker/seed-chat-bubble.mjs)）：启动时只给
**还没有显式偏好**的账号写 `'0'`。

* 你在界面里重新打开它 → 库里变成 `'1'`，脚本**永远不会**再改回去；
* 你手动关掉 → `'0'`，同样不动；
* 它跑在后台：新卷上主账号要等网关起来才存在，脚本会等到账号出现再写。

想默认开启就设 `DSH_PASSWORDS_CHAT_BUBBLE=1`。
注意是"还没有偏好"才写，所以**在容器运行期间新建的子账号**要等下次重启才拿到该默认值
（插件本身的按用户语义如此）。

### 3.8 「打开配置文件」在容器里不可用：已按设计隐藏

设置 → 通用 里的「打开配置文件」是把 profile 的设置文档交给**宿主机的默认文本编辑器**
打开，而且 DSH 只对**回环浏览器**提供它（远程浏览器不注册这个动作）。容器里出现并失败
的原因有两层：

1. 经 dsh-passwords 网关进来的请求，对 DSH 来说源地址是回环，于是它照旧提供了这个
   宿主本地动作；
2. 容器里没有桌面，点击后执行 `xdg-open` 必然失败，界面就显示「无法打开配置文件」。

DSH 其实有 `canOpenNativePath()` 这个守卫（它的注释写着"无桌面/容器化的 Linux 应把路径
显示成文本，而不是给一个会把 `xdg-open` 扔进虚空的按钮"），但那个按钮没有调用它。而且
即使调用了，在本机这种 Windows + Docker Desktop 环境里容器内核字符串带
`-microsoft-standard-WSL2`，`isWsl()` 会把容器误判成"能连到 Windows 桌面"。

本镜像因此在**构建期**打了个最小补丁
（[docker/patch-dsh-settings-document.mjs](docker/patch-dsh-settings-document.mjs)）：
让 `describe()` 的 `hasDocument` 在容器里如实返回 `false`。客户端随即落在
`status !== 'ready'`，按钮**整个不渲染**（源码就是 `if (state.status !== "ready") return null`）。
补丁锚点发生变化会让**构建失败**，而不是悄悄漏打；在真有桌面且非容器的宿主机上，按钮会
自己回来。

**那这个按钮本来要做的事（改配置文件）怎么做？**

```bash
# 直接进容器编辑（镜像里已装 nano）
docker exec -it dsh nano /data/dsh/profiles/web/cordis.patch.yml
docker compose restart        # 稳妥；通常 HMR 也会自己热加载（配置树里 hmr 是启用的）

# 或者取出来改再放回去
docker cp dsh:/data/dsh/profiles/web/cordis.patch.yml .
# …编辑…
docker cp ./cordis.patch.yml dsh:/data/dsh/profiles/web/cordis.patch.yml
```

大多数设置直接在界面里改即可——界面写的**就是**这个文件（我们已经在里面看到 GUI 写入的
`ui-settings-general` 条目）。手改时记住层级：这个文件是**用户 patch 层**，镜像默认值在
更低的 `dsh-local-defaults` bundle 里，所以写在这里的值总是优先。

### 3.9 模式只保留「标准模式」，会话界面不再有模式选择

DSH 的「模式」是 **agent preset**（一套工具与提示的组合）。web 组合出厂有四个：

| id | 界面名 |
|---|---|
| `standard` | 标准模式 |
| `ptc` | PTC |
| `minimal` | 极简 |
| `cordis` | 创造者 |

默认值本来就是 `standard`；会话界面那个「模式」按钮/菜单就是 `ui-agent-preset` 的
**seat 选择器**（新建任务界面上选模式的地方）。本镜像在默认层
（[docker/defaults/cordis.patch.yml](docker/defaults/cordis.patch.yml)）里这样收敛：

```yaml
- id: preset-ptc
  disabled: true
- id: preset-minimal
  disabled: true
- id: preset-cordis
  disabled: true
- id: agent-preset-registry
  config:
    default: standard
- id: ui-agent-preset
  disabled: true      # 新建任务的模式 seat、会话头部的模式名、设置里的「代理预设」页
```

* 关掉的预设不是「藏起来」，而是**根本不存在**：按 id 请求 `ptc`/`minimal`/`cordis` 会得到
  `agent-preset/not-found`。
* 去掉选择器**不影响新建会话**：`session.create` 的请求 schema 里 `agentPreset` 是可选的
  （`z.string().optional()`），缺省时宿主 `resolve(id ?? defaultId)` 回落到注册表默认值，
  也就是 `standard`——所以会话照旧跑标准模式。
* `ui-agent-preset` 是整块关掉的，因此会话头部那个只读模式名和「设置 → 代理预设」页也一并
  消失（只剩一个模式时它们没有意义）。
* 想恢复：删掉这几条，或者在你自己的 profile patch 里覆盖——默认层永远低于用户 patch 层。

---

## 4. 版本与升级：默认自动跟随最新

三个组件默认都**自动解析成当前最新且互相兼容的版本**，在**构建镜像时**（不是运行时）
完成解析；结果会打印在构建日志里，也写在镜像内 `/opt/dsh-versions.json`：

```bash
docker exec dsh cat /opt/dsh-versions.json
```

| 构建参数 | 默认 | 说明 |
|---|---|---|
| `DSH_VERSION` | `latest` | **不取 npm 的 `latest` 标签**——那个标签当前指向 `0.2.0-rc.2`，会被 dsh-passwords 拒绝启动。改为读取 dsh-passwords 自己声明的兼容范围（当前 `>=0.2.1-alpha.1 <0.2.2-0`），在其中取最新版本。插件升级门禁时这里会自动跟着走。 |
| `DSH_PASSWORDS_VERSION` | `latest` | 网关插件，取它的 `latest` 标签 |
| `SKIN_CENTER_VERSION` | `latest` | 皮肤管理中心，取它的 `latest` 标签 |
| `DS_BOT_VERSION` | `latest` | ds-bot（只安装、默认不启用），取它的 `latest` 标签 |
| `PNPM_VERSION` | `latest` | 构建/安装工具，不属于上面这些组件 |

**升级到最新**（版本解析结果会被 Docker 层缓存，所以要给一个会变的值）：

```bash
# PowerShell
$env:DSH_REFRESH = (Get-Date -UFormat %s); docker compose build; docker compose up -d
# bash
DSH_REFRESH=$(date +%s) docker compose build && docker compose up -d
```

已有的数据卷**不需要删**：镜像换了版本后，容器启动时会把 profile 里的插件对齐到
镜像解析出的版本（对齐需要装包时会跑一次 `pnpm install`），皮肤与账号都不动。

**钉死版本**（可复现构建）：在 `.env` 里取消注释对应行即可，例如
`SKIN_CENTER_VERSION=0.4.4`。构建期还有两条硬校验：装完的版本必须与解析结果一致、
node-pty 的 Linux 预编译必须存在（pnpm 版本漂移导致 `allowBuilds` 失效时会在这里
直接失败，而不是悄悄装出一个残废镜像）。

> 运行期每次启动都会把 profile 的 `@linxin666/dsh-client-ui-skin-center` 依赖与 bundle
> 条目对齐到镜像解析出的版本（与官方 `register-plugin.mjs` 对齐 dsh-passwords 的做法
> 一致）。所以升级皮肤中心请重建镜像，而不是在界面里升级插件——后者会在下次重启时
> 被改回镜像版本。

---

## 5. nginx 反代要点

```nginx
location / {
    proxy_pass http://127.0.0.1:3088;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;      # WebSocket 必须
    proxy_set_header Connection "upgrade";
    proxy_set_header Host              $host;       # 保留外部 Host
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_read_timeout 3600s;                        # SSE / 长连接
    client_max_body_size 0;                          # 附件上传
}
```

反代固定域名后，建议在 `.env` 里设 `MCP_GATEWAY_PUBLIC_HOST=<域名>`。
皮肤视频是 `mp4`，`proxy_buffering` 一般不用动；若要抽帧跳转，可对
`/api/skin-center/` 关闭缓冲。

---

## 6. 目录结构与数据

```
Dockerfile                     镜像构建（DSH + 网关 + 皮肤中心 + 皮肤）
docker-compose.yml             单容器编排，发布 3088
.env.example                   复制为 .env 使用
docker/
  entrypoint.sh                启动流程（见下）
  resolve-versions.mjs         构建期解析各组件的最新兼容版本
  register-web-plugins.mjs     一次性注册 profile 插件（只跑一次 pnpm install）
  seed-skins.mjs               预置皮肤；默认保持官方原版外观（幂等）
  seed-credential.mjs          把环境里的模型 Key 种进凭据文件（幂等）
  seed-workspace.mjs           写入默认工作区 /workspace（只在没有工作区时）
  seed-chat-bubble.mjs         把 dsh-passwords 的可拖动聊天气泡默认关掉
  patch-dsh-settings-document.mjs  隐藏容器里无法工作的「打开配置文件」
  bootstrap-admin.mjs          用配置的默认密码自动建号
  defaults/                    默认值 bundle：浅色主题（位于用户 patch 之下）
  skin-center-active.json      皮肤激活状态种子（active: null = 官方外观）
skins/whale-fantasy/           皮肤本体（含上游 LICENSE；默认不激活）
tests/                         本地可跑的测试 + 部署后冒烟测试
```

启动流程（`docker/entrypoint.sh`，全部幂等）：

```
docker-init            生成/沿用网关配置与 SETUP_KEY
register-web-plugins   插件一次装好（只跑一次 pnpm install）
register-plugin        官方脚本复核 dsh-passwords（状态一致时直接短路）
状态门禁               网关插件没物化就拒绝启动
patch                  给 DSH 打网关所需补丁（失败则拒绝启动）
seed-skins             预置 whale-fantasy（不激活，保持官方原版外观）
seed-credential        把环境里的模型 Key 种进凭据文件，随后丢弃该环境变量
seed-workspace         写入默认工作区（/workspace），新建会话无需先选目录
bootstrap-admin        后台按配置的默认密码建号（失败只告警）
seed-chat-bubble       后台把 dsh-passwords 的可拖动聊天气泡默认关掉
HOME=/workspace        让工作区选择器默认落在 /workspace（选择器读 os.homedir()）
exec dsh web           启动 DSH Web，网关由插件接管
```

> **两个插件的注册顺序是有原因的。** 如果先只装皮肤中心、再让官方
> `register-plugin.mjs` 补装 dsh-passwords，第二次 `pnpm install` 需要 prune 上一次的
> 结果；实测 pnpm 11.7.0 在这条路径上会**打印 `Done` 之后不退出**（进程空闲、无网络
> 连接、libuv worker 常驻），首次启动就永久卡住。所以本镜像先一次性把两个条目都写进
> manifest、只跑一次 `pnpm install`，官方脚本随后走它自己的
> `profile dependencies already ready` 短路，不再调用 pnpm。
> 另外两处 pnpm 调用都套了 `timeout`（`DSH_SETUP_TIMEOUT_S`，默认 900s），
> 并以「结果状态」而不是子进程退出码作为判据（见第 6 行流程的“状态门禁”）。
>
> 为什么不用 `dsh plugin add`：它的 reconcile 会把所有声明 `dsh.bundle` 的依赖
> 全部塞进 bundle 层，在已经注册了 dsh-passwords 的情况下会触发
> `duplicate loader entry id` 导致 DSH 起不来。所以两个插件都用“精确改 manifest”
> 的方式注册（`register-web-plugins.mjs` 与官方 `register-plugin.mjs` 同思路）。

数据目录（宿主机 bind mount，不再是 Docker 命名卷）：

| 宿主机路径 | 容器路径 | 内容 |
|---|---|---|
| `${DSH_DATA_DIR}/dsh-home` | `/data/dsh` | DSH_HOME：profile、插件、会话、皮肤 |
| `${DSH_DATA_DIR}/dsh-passwords` | `/data/dsh-passwords` | `.env`、SQLite 库、审计与登录限流 |
| `${DSH_DATA_DIR}/workspace` | `/workspace` | agent 的工作区（`WORKDIR`） |

`DSH_DATA_DIR` 默认 `/data/deepseek-harness-all-in-one`（在 `.env` 里改）。

**这个 `/data` 在哪、要注意什么（Docker Desktop on Windows）**

- 绝对路径 `/data/...` 是 **Docker Desktop 虚拟机内部**的路径，实际落在
  `%LOCALAPPDATA%\Docker\wsl\disk\docker_data.vhdx` 里；Windows 的 `C:\data` / `D:\data`
  并不存在，资源管理器里也看不到。
- ✅ 好处：容器重启、`docker compose down`、甚至 `docker compose down -v` 与
  `docker volume prune` 都**不会再删掉它**（已经没有任何命名卷了）。
- ❌ 坏处：Docker Desktop 的 **Reset / Purge data**、重装 Docker Desktop 会连同它一起清掉；
  也没法用 Windows 工具直接备份。
- 想放到 Windows 可见、可备份的位置：在 `.env` 里设
  `DSH_DATA_DIR=D:/data/deepseek-harness-all-in-one`（或 `/d/data/...`），然后
  `docker compose up -d` 重建容器即可（数据会被搬到该目录）。

备份就是复制 `$DSH_DATA_DIR` 这三个子目录；恢复就是放回去再 `up -d`。
在 Linux 宿主机上默认值本身就是 `/data/deepseek-harness-all-in-one`，无需改动。

---

## 7. 常见问题

| 现象 | 处理 |
|---|---|
| 容器起来但 3088 打不开 | `docker compose logs dsh`；看到 `FATAL: dsh-passwords patch failed` 说明 DSH 版本不在插件支持范围内 |
| 想重新走首次配置 | `docker compose down -v` 后 `up -d`（会清空所有数据） |
| 忘了主用户密码 | 停容器删 `users` 表（见 dsh-passwords 文档），或 `down -v` 重来 |
| 皮肤没生效 | 打开「设置 → 皮肤中心」看是否列出 whale-fantasy；确认 `docker exec dsh ls /data/dsh/skins` |
| 想让 DSH 少看见外面 | 把 compose 的 ports 改成 `"127.0.0.1:3088:3088"`，只走 nginx |
| 容器内改端口 | 不要改；`MCP_GATEWAY_PORT`/`DSH_WEB_PORT` 与 `MCP_GATEWAY_UPSTREAM` 是绑定的，改对外端口请改 `DSH_PORT` |

---

## 8. 安全

完整的安全审查报告（工具 + 人工审计、逐条核验结论、残余风险）见
[SECURITY-REVIEW.md](SECURITY-REVIEW.md)。要点：

- **密钥不进镜像、不进 git**：全历史与悬垂对象扫描无密钥；`.dockerignore` 排除 `.env*`；
  构建参数只有版本号。
- **密钥可以不进环境变量**：设 `DEEPSEEK_API_KEY_FILE` / `DSH_ADMIN_PASSWORD_FILE` /
  `SETUP_KEY_FILE`（把文件挂到 `/run/secrets` 只读），`docker inspect` 里就不会出现内容。
- **状态权限只对属主开放**：入口 `umask 077`，并对既有状态执行 `chmod -R go-rwx`
  （网关 SQLite 曾是 `0644`，现已 `0600`）。宿主机 `.env` 的 ACL 也应收紧到属主+SYSTEM+Administrators。
- **传输必须由 nginx 终结 TLS**：3088 本身是明文 HTTP，登录口令与会话 cookie 不能裸奔；
  只把 3088 暴露给反代，不要直接开到公网。
- **完全权限是刻意的**：`DSH_PERMISSION_MODE=danger-full-access` 让 agent 能在容器内执行任意命令，
  容器即信任边界——不要把宿主机敏感目录或 docker.sock 挂进去。
- 版本号在写入构建环境文件前都经严格 semver 校验（无 shell 注入面）；钉的版本不存在时构建直接失败。
## 9. 本仓库做过的验证

开发机（Windows + Docker 29.8.2 / Compose v5.5.1，Linux 容器）上**实际构建、部署并跑过**：

| 验证 | 结果 |
|---|---|
| `docker compose build`（含版本自动解析） | 成功，解析出 DSH `0.2.1-alpha.2` / dsh-passwords `2.7.8` / 皮肤中心 `0.4.6` / ds-bot `0.1.2`，原生模块 install 脚本全部执行 |
| 冷启动（空卷）`docker compose up -d` | 一次 `pnpm install` → 短路 → 打补丁 → 建号 → 网关就绪，全程秒级，`(healthy)` |
| `docker compose restart` | 脚本都走“已就绪”短路，不再跑 pnpm，秒级恢复 |
| **镜像版本传播**：镜像解析 0.4.6、卷里还是 0.4.4，重启一次 | 自动升级到 0.4.6（会删包的那条安装路径 1.9s 干净退出），皮肤与账号不受影响 |
| `tests/deployment-smoke.test.mjs`（网关登录 + 首页 + 外观/主题 + 气泡开关 + 默认工作区 + 无模式选择） | **19/19** |
| `tests/defaults-bundle.test.mjs`（默认层：浅色主题 + 只剩标准模式的收敛策略） | 13/13 |
| **默认外观**：`skin-center-active.json` + 首页 | `active: null`；首页无 `data-dsh-skin`、无皮肤资源注入，皮肤中心插件仍在（可自行启用） |
| **默认浅色主题**：`dsh-local-defaults` bundle + 首页 | `--dump-config` 里 `ui-theme.config.preference: light`；首页含 `color-scheme:light` |
| **模型 Key 可改**：凭据播种 + 进程环境 | `refs.DEEPSEEK_API_KEY` 已写入 `.credentials.yaml`（records 保留）；`dsh web` 与网关进程的 environ 里**都没有** `DEEPSEEK_API_KEY` |
| **Key 走凭据文件仍能推理** | 容器内 `dsh --profile headless` 回合退出码 0，正常回答 |
| **默认完全权限** | `DSH_PERMISSION_MODE=danger-full-access`；agent 用 bash 在 `/workspace` **之外**写入 `/tmp/dsh-perm-check.txt` 成功 |
| **ds-bot 已装未启用** | `dependencies["ds-bot"]=0.1.2`、`node_modules/ds-bot` 存在，但不在 `dsh.profile.bundles`，`--dump-config` 里也没有 ds-bot |
| **工作区默认目录 = /workspace** | `dsh web`（pid 10）与网关（pid 96）进程的 `HOME` 都是 `/workspace`，`os.homedir()` 返回 `/workspace`（选择器的默认列表与面包屑顶端就是它） |
| **默认工作区已存在** | 启动后 `/data/dsh/storages/workspace.json` 里 `workspaceIds` 有 1 条、`tables.workspaces` 里 `path=/workspace`、`title=default-workspace`；DSH 启动无任何 workspace/storage 报错，文件在完整启动后被原样保留 |
| **工作区被 DSH 认下（产品接口）** | `GET /api/dsh-passwords/workspaces` → `{path:"/workspace", title:"default-workspace", sessions:[…]}`，且已有会话挂在该工作区下 |
| **可拖动聊天气泡默认关闭** | 启动日志 `set the chat bubble off for account id(s) 1`；`GET /api/dsh-passwords/state` → `"chatEnabled": false` |
| **模式只剩标准** | `--dump-config`：`preset-ptc/minimal/cordis` 与 `ui-agent-preset` 均 `disabled: true`，`preset-standard` 启用，`agent-preset-registry.default: standard`；`session.create` 的 `agentPreset` 字段可选，缺省即回落 `standard` |
| **界面没有模式选择** | 冒烟测试断言首页下发的插件清单**不含** `dsh-client-ui-agent-preset/client.js`（浏览器根本不加载这套 UI） |
| **「打开配置文件」不再出现** | 镜像构建期打上补丁；容器内直接求值该表达式得 `canOpenNativePath:true, inContainer:true → hasDocument:false`，客户端据此 `status='unavailable'` 并不渲染按钮；DSH 启动无报错 |
| 容器内 `dsh --profile web --dump-config` | 皮肤中心与 dsh-passwords 都在树里，无 `duplicate loader entry id` |
| 容器内直连模型 API（`api.deepseek.com`） | HTTP 200，返回 `PONG`，证明密钥与出网都正常 |
| `tests/resolve-versions.test.mjs`（跟随 latest、跟随插件门禁、不踩 `0.2.0-rc.2`、钉版本、非法值/不存在的钉版本都报错） | 18/18 |
| `tests/pnpm-hang-recovery.test.mjs`（假 pnpm 干完活不退出 → 仍算成功并回收；ds-bot 只装不启用） | 17/17 |
| `tests/seed-credential.test.mjs`（播种、不覆盖已有值、退出码语义、坏文件不动、缺库不半写） | 15/15 |
| `tests/seed-workspace.test.mjs`（注册表格式、只补空缺、用户工作区不动、坏文件不动、路径规范化） | 29/29 |
| `tests/seed-chat-bubble.test.mjs`（默认写 0、显式选择不被覆盖、可配、幂等、无账号时有界退出） | 19/19 |
| `tests/entrypoint-contract.test.mjs`（HOME=/workspace 的时机、只在播种成功后才丢 Key、网关门禁、umask/权限收口/文件式密钥等启动契约） | 26/26 |
| `tests/patch-dsh-settings-document.test.mjs`（补丁只改两处锚点、幂等、锚点变了就让构建失败） | 20/20 |
| `docker/bootstrap-admin.mjs` 对 mock 网关（复刻真实 cookie/CSRF/表单契约） | `tests/bootstrap-admin.test.mjs` 22/22 |
| `docker/seed-skins.mjs`（预置、默认官方外观、幂等、不覆盖用户选择） | `tests/seed-skins.test.mjs` 23/23 |
| `tests/build-config.test.mjs`（compose 构建参数 ↔ Dockerfile `ARG`、COPY 源存在、entrypoint 引用的脚本已 COPY、compose 变量都有默认值、状态路径都有卷、只发布一个端口） | 56/56 |

测试都能在本地直接跑（`resolve-versions` 需要网络），部署冒烟那条对运行中的实例跑：

```bash
node tests/resolve-versions.test.mjs
node tests/pnpm-hang-recovery.test.mjs
node tests/seed-credential.test.mjs
node tests/seed-workspace.test.mjs
node tests/seed-chat-bubble.test.mjs
node tests/patch-dsh-settings-document.test.mjs
node tests/defaults-bundle.test.mjs
node tests/bootstrap-admin.test.mjs
node tests/seed-skins.test.mjs
node tests/entrypoint-contract.test.mjs
node tests/build-config.test.mjs
DSH_ADMIN_PASSWORD='你的密码' node tests/deployment-smoke.test.mjs http://127.0.0.1:3088
```

最贴近“用户真的能用”的一条检查是容器内的 agent 回合（同时验证模型与权限）：

```bash
docker exec -u node -w /workspace dsh timeout 240 dsh --profile headless \
  "Use the bash tool to run exactly: echo PERMOK > /tmp/dsh-perm-check.txt   Then reply with exactly one word: DONE"
```

### 踩过并已修掉的坑（供以后排查参考）

1. **pnpm 11.7.0 偶发“干完不退出”。** 安装已完成、`Done` 也打印了，进程却常驻
   （空闲、无 socket、libuv worker 存活），在需要删包的升级路径上更容易触发。
   现在 `register-web-plugins.mjs` 用**异步 spawn + 轮询目标状态**判定成功：进程不
   退也算完成，宽限期后回收（POSIX 用 SIGTERM/SIGKILL，Windows 用 `taskkill /T`）。
   回归测试见 `tests/pnpm-hang-recovery.test.mjs`。
2. **Docker 会在 shell 之前用 ARG 展开 RUN 里的 `${VAR}`。** 所以“把解析结果 source
   进环境再引用同名变量”会被默认值 `latest` 静默顶掉，解析结果一律用 `RESOLVED_*`。
3. **两次 pnpm install 是没必要的。** 两个插件在同一份 manifest 里一次装好，官方
   `register-plugin.mjs` 随后自然短路。

### 已知未覆盖的点

* 首次启动会联网装插件（皮肤中心的几个包）；离线环境下这一步会失败，但入口脚本把它
  降级为“告警 + 没有皮肤中心”，DSH 与登录网关照常可用（第 6 步的硬门禁只管
  dsh-passwords）。
* 皮肤自带的视频背景（`assets/whale-fantasy-loop.mp4`）与 `backdrop-filter` 的实际观感
  由浏览器决定，本仓库只验证了资源能正确下发（HTTP 200 + 内容为真皮肤）。


---

## 10. 许可与致谢

* DSH 与各官方插件：MIT（@deepseek-ai/*）
* `dsh-passwords`：GPL-3.0-only — <https://github.com/slywalker2006/dsh-passwords>
* `@linxin666/dsh-client-ui-skin-center`：Apache-2.0 — <https://github.com/zhu1090093659/dsh-skins>
* `whale-fantasy` 皮肤：**CC BY-NC-SA 4.0**（署名 · 非商业 · 相同方式共享），
  作者 `stushansusu`。镜像内保留了皮肤目录里的 `LICENSE` 与 `README` 作为署名，
  商用前请自行确认授权。
