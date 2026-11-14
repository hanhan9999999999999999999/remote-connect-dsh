# dsh-remote-connect · 架构

> 把「手机遥控」升级成「远程互联」：两台装了同一插件的 DSH，互相看得见、连得上、数据能一键搬过去。

## 1. 产品边界

| 能力 | 归属 | 说明 |
| --- | --- | --- |
| 设置页「远程互联」 | 本插件 client 半侧 | 注册进 `settings.section`，是官方设置面板的一等公民 |
| 本机互联服务（监听/密码/发现） | 本插件 host 半侧 | Node 内置模块实现，不依赖 DSH 的 Web 端口 |
| 局域网发现 | 本插件 host 半侧 | UDP 广播应答（无第三方依赖） |
| 两台 DSH 之间的数据同步 | 本插件 host 半侧 | 清单 → 计划 → 打包 → 应用 → 备份/回滚 |
| 手机通道开关 | 本插件 host 半侧（`host/phone.mjs`） | 同进程挂载 `/dsh-phone-api/*`，并给设置页提供 `/dsh-remote-connect-api/phone/*` 代理 |

插件**不修改** DSH 本体，不改宿主 asar，不注入代码；只使用公开的插件契约
（`ctx.slots`、`webServer.register`）。

## 2. 进程与层次

```
┌──────────────────────────────────────────────────────────────────┐
│ DSH 主进程（cordis 插件跑在这里）                                │
│ host/index.js  (cordis 插件)                                     │
│   ├─ 注册 /dsh-remote-connect-api/*   ← 设置页调用（同源 HTTP）  │
│   └─ LinkService（单例）                                         │
│        ├─ LinkServer   :8788   TCP HTTP + UDP 发现               │
│        ├─ RemotePeer   连接远端 LinkServer                       │
│        ├─ Inventory    扫描 $DSH_HOME → 分类清单                 │
│        ├─ Archiver     纯 JS tar + gzip（无依赖）                │
│        ├─ Applier      暂存 → 校验 → 备份 → 落盘 → 日志/回滚     │
│        ├─ Guard        失败锁定 / 签名窗口（host/guard.mjs）     │
│        ├─ 日志环 / TaskTable（host/tasks.mjs，内存，上限 40）    │
│        └─ 手机通道 host/phone.mjs → host/port-scan.mjs（端口）   │
│ 对端是另一台机器的同款服务（HTTP 可选 / 应用层 GCM 加密）        │
└──────────────────────────────────────────────────────────────────┘
```

为什么要自己起一个端口，而不是挂在 DSH 的 Web 服务上？

- DSH 的 Web 服务默认只监听回环，改它有风险；
- 同步服务需要长期在线、可被局域网访问、可单独开关；
- 端口冲突、防火墙、隧道都能独立处理，不牵连 DSH 本身。

## 3. 安全模型

三层，层层独立：

1. **连接密码**：默认随机生成 3 组 4 字符（`XXXX-XXXX-XXXX`，字母表 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`，不含易混的 `I/O/0/1`），可改成任意自定义密码。
   派生 `scrypt(password, salt, N=2^14, r=8, p=1)` → 32 字节主密钥 `K`。
   `K` 从不落盘、从不上线；salt 存在本机配置里。
2. **握手**：`hello` 双向挑战（`clientNonce` / `serverNonce`），客户端提交
   `HMAC(K, "hello|clientNonce|serverNonce|deviceId")`，服务端常量时间校验。
   成功后服务端发一次性会话令牌（32B，默认 12 小时），并派生出会话密钥
   `SK = HKDF(K, "session|clientNonce|serverNonce")`。
3. **报文**：每个请求带 `x-dl-ts`、`x-dl-nonce`、`x-dl-mac = HMAC(SK, method|path|ts|nonce|sha256(body))`；
   请求/响应体用 `AES-256-GCM(SK)` 加密。时间偏移 > 300s 或 nonce 复用直接拒绝。

附加约束：

- 密码错误按 IP 计数，连续失败 10 次锁 10 分钟（成功认证即清零；没有指数退避）；
- 局域网发现（UDP）收到的应答一律当不可信输入：`m`/`v` 必须匹配、`id` 非空且截 64 字符、
  端口必须是 1–65535 的整数、`name`/`platform`/`version` 截断，缺字段的整条丢掉——
  否则一个乱发的包就能在列表里塞进端口为 `NaN` 的「对端」；
- 所有路径在服务端二次校验（拒绝 `..`、绝对路径、盘符、保留名）；
- 单文件上限 512 MB、单次同步上限 8 GB（可配置 `sync.maxTotalMb`），超出在清单阶段就拒绝（清单已经带总大小，不会先把文件逐个哈希一遍再说超限）；推送方向更早——`/apply/prepare` 一收到对端声明的总大小就核对，超了回 413 `TOO_LARGE`，一个字节都不让传；
- 默认**不传输**（`host/inventory.mjs` 里的 `SECRET_FILE` / `ALWAYS_EXCLUDE_*`）：
  `.credentials.yaml`、`.dshw-api.json`、`model_config.json`、`.env*`、`*.pem|key|p12|pfx`、
  `id_rsa|ed25519|ecdsa*`、`.netrc`、`cookies*`；`node_modules/`、`.git/`、`.venv/`、`dist/`、
  `build/`、`coverage/`、`__pycache__/` 等目录；`*.log|tmp|part|swp|map|lock` 与 `.DS_Store`/`Thumbs.db`。
- **本插件自己的数据目录永远排除**（`config.json` 存连接密码、`peers.json` 存会话密钥、`backups/` 存别人的旧文件）。
- **哈希缓存**存在 `<data>/hash-cache.json`（最多 20000 条，载入时也按上限裁剪），键是 `路径|大小|mtime`：
  大小和修改时间都没变就不重算 sha256。这是**启发式**——如果外部工具改了内容又把 mtime 改回去，
  缓存会给出旧值（两端校验会因此对不上），删掉这个 json 或重装插件即可强制重算。
  读文件失败（扫描之后被删、被独占锁）报 `READ_FAILED`，不会把裸 `ENOENT` 冒到 HTTP 层。
- 开启「包含凭据」需在同步页显式勾选，且会在同步报告里单独标注（清单里的 `includeSecrets`）。**勾上之后目录深处的凭据也一起走**——这个开关以前只对分类根目录下那几个直接文件生效，目录里的照旧被悄悄丢掉；日志/临时文件与超单文件上限的仍然不受它影响。
- **配置读入时会被收拾一遍**（`host/config.mjs`）：缺字段补默认值、字符串 `"false"` 当 false、端口夹在 1024–65535、`maxFileMb`/`maxTotalMb` 夹在 1–65536、`backupKeep` 夹在 1–50、不认识的同步分类直接丢掉、`auth.kdf.N` 必须是 ≥ 默认值的 2 的幂（手改小了不会悄悄降低 KDF 强度）。
- **配置文件坏了不会被覆盖**：`config.json` 不是合法 JSON、或内容不是对象时，`load()` 抛 `CONFIG_BROKEN` 并原样保留文件——直接用默认值写回去会把主人的连接密码弄丢。读不到（权限）报 `CONFIG_UNREADABLE`。
- **`peers.json` 认不出就丢那一块**：手改过或别的程序写进去的怪记录（`null`、字符串、端口 0）在载入时逐条收窄——缺 `host` 或端口不在 1–65535 的直接丢，字段超长截断、`scheme` 只认 `http`/`https`；整个文件不是数组时挪成 `peers.json.broken-<时间戳>` 再从空的开始。写盘是串行的（并发 `upsert` 不会互相覆盖临时文件与 rename）。

## 4. 数据模型

同步内容按**分类**组织，每类有自己的扫描规则与排除规则：

| 分类 | 源路径（相对 `$DSH_HOME`） | 默认 | 说明 |
| --- | --- | --- | --- |
| `skills` | `skills/**`、`skills-index.md`、`skills-manifest.json`、`skills-sync.mjs` | 开 | 排除 `node_modules`、`.git`、超过单文件上限的资源 |
| `rules` | `prompt-inject.md`、`prompt-reminder.md`、`cordis.patch.yml`、`.agent-presets/**` | 开 | 本地条款/预设 |
| `plugins` | `plugins/**`（排除 `node_modules`/`.git`/模型）+ profile 的 `package.json` 依赖与 `bundles` | 开 | 只同步**源码级**插件；注册表依赖生成「依赖清单」供对端一键补齐 |
| `config` | `profiles/**`、`storages/**`、`task-board`、`pet.json`、`tts.json`、`voice.json`、`asr.json`、`watch.json`、`see-now.json`、`dsh.json`、`dsh.config.json`、`settings.json` | 开 | 排除 `storages/session_projcache` |
| `sessions` | `sessions/**` | 开 | 会话存档（对话记录），保留工作区目录编码与 `session-*` 结构 |
| `plugin-data` | `plugins-data/**`、`meow-memory/**`、`memory-nebula/**`、`dsh-see-now/**` | 关 | 体积不可控，默认关，逐项勾选 |

清单条目：

```json
{ "cat": "skills", "rel": "skills/foo/SKILL.md", "size": 1234, "mtime": 1760000000000, "sha256": "…" }
```

应用策略：

- 目标已存在且 `sha256` 相同 → 跳过；
- 目标存在但不同 → 先备份到 `<data>/backups/<syncId>/<rel>`，再写；
- 目标不存在 → 直接写；
- 目录/文件权限沿用，Windows 上忽略 mode；
- 应用完成写 `journal.json`，`rollback` 可按反向顺序还原（仅本次同步涉及的文件）。
- 半途失败的批次没有 `journal.json`，但 `journal.jsonl` 是逐行落盘的，`rollback` 会退回用它还原，并在结果里标 `partial: true`，同时补写一份 `journal.json`（避免下次又被当成半成品）。

## 5. 传输契约

### 5.1 服务端（被连接的一侧）

前缀 `/dsh-link/v1`（`host/server.mjs` 的 `BASE`）。除 `/health` 外都要带会话签名，响应体是 GCM 信封。

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| GET | `/health` | 公开 | 版本、协议、设备名、是否设密码、分类摘要（不含密钥） |
| POST | `/hello` | 公开 | 提交 `deviceId`，返回 `salt`、KDF 参数、`serverNonce`、挑战 id |
| POST | `/hello/verify` | 公开 | 提交 `HMAC(K, …)` 证明，返回会话令牌与 `expiresAt` |
| GET | `/ping` | 会话 | 心跳，返回 `{ok, t, device}` |
| POST | `/inventory` | 会话 | 请求体 `{cats, includeSecrets?}`；返回清单 + 统计 |
| POST | `/export/prepare` | 会话 | 请求体 `{cats, manifestId}`；返回 `{packId, …}` |
| GET | `/export/<packId>` | 会话 | 逐帧加密的 `tar.gz` 流 |
| POST | `/apply/prepare` | 会话 | 建一次本地应用任务，返回 `{syncId, maxTotalBytes}`；请求里的 `totalBytes` 超本机上限直接 413 `TOO_LARGE` |
| PUT/POST | `/apply/<syncId>` | 会话 | 上传逐帧加密的 `tar.gz` 流（流式，上限由 `sync.maxTotalMb` 决定，已在 prepare 阶段核对过） |
| GET | `/progress?syncId=` | 会话 | 应用进度（已写字节/总字节/当前文件） |
| GET | `/syncs` | 会话 | 本机最近 20 次应用记录 |
| POST | `/rollback` | 会话 | `{syncId}` 回滚一次应用 |
| POST | `/bye` | 会话 | 主动注销本会话令牌 |

### 5.2 本机插件路由（设置页用）

前缀 `/dsh-remote-connect-api`（`index.js` 的 `PREFIX`），全部同源、走 DSH 自带的鉴权，共 30 条：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/status` | 本机状态：设备名、端口、对端数、任务 |
| GET | `/diagnostics` | 依赖/端口/权限等自检 |
| GET | `/logs` | 最近 300 行日志 |
| POST | `/config` | 改配置（端口、同步策略等） |
| GET | `/deps` · POST `/deps/install` | 插件依赖检查 / 补装 |
| POST | `/device/name` | 改设备名 |
| POST | `/password/set` · `/password/rotate` | 设密码 / 换密码 |
| POST | `/server/start` · `/server/stop` | 起停本机 `:8788` 互联服务 |
| POST | `/discover` · `/connect` | UDP 发现 / 配对连接 |
| POST | `/peer/disconnect` · `/peer/forget` · `/peer/rename` · `/peer/probe` | 对端管理 |
| POST | `/inventory` · `/sync` | 列可同步内容 / 发起同步 |
| POST | `/task/status` · `/task/cancel` | 同步任务进度 / 取消 |
| POST | `/local/syncs` · `/local/rollback` | 本机应用记录 / 回滚 |
| POST | `/remote/syncs` · `/remote/rollback` | 对端记录 / 让对方回滚 |
| GET | `/phone/status` | 手机通道状态（同进程直连，不走回环） |
| POST | `/phone/start` · `/phone/stop` · `/phone/port` · `/phone/paircode` | 手机通道启停、换端口、改配对码（参数在请求体：`{port}` / `{code}`；过去这四条固定空体，换端口与改码永远做不成） |

手机通道自己还注册了 5 条 `/dsh-phone-api/*`（`status`、`start`、`stop`、`port`、`paircode`），
供桥接侧和调试脚本直接调用。

### 5.3 错误码 → HTTP 状态码

`index.js` 里有一张固定的映射表（`STATUS`），没登记的错误码一律 500——但响应体里一定带可读的 `error.message`。
分成五类，界面据此决定是「让你改点什么」还是「这像是坏了」：

| 状态码 | 错误码 | 含义 |
| --- | --- | --- |
| 401 | `BAD_PASSWORD` `LOCKED_OUT` `UNAUTHORIZED` `SESSION_EXPIRED` | 密码不对 / 被锁 / 会话失效 |
| 403 | `KEY_MISMATCH` | 两边的会话密钥对不上（多半是改过密码） |
| 404 | `PEER_UNKNOWN` `TASK_UNKNOWN` `SYNC_UNKNOWN` | 找不到这个对端 / 任务 / 批次 |
| 409 | `NOT_CONNECTED` `NEED_PASSWORD` `NO_PASSWORD` `PORT_IN_USE` `SYNC_BUSY` `NO_JOURNAL` `ALREADY_ROLLED_BACK` | 现在做不了，但不是参数错 |
| 400 | `BAD_INPUT` `BAD_JSON` `NO_HOST` `METHOD` `CATEGORY` `EMPTY` `BAD_PLUGIN_ID` `PATH_ESCAPE` `VERSION_MISMATCH` | 参数或内容不对 |
| 413 | `TOO_LARGE` `BODY_TOO_LARGE` | 内容/请求体超过上限（同步页可以改「同步上限」或分批） |
| 502 | `NETWORK` `TIMEOUT` `NOT_DSH_LINK` `BAD_RESPONSE` `BAD_ENVELOPE` `PHONE_BAD_RESPONSE` `NO_PORT` | 对端的问题，本机没坏 |
| 500 | 其余（`READ_FAILED` `CONFIG_BROKEN` `CONFIG_UNREADABLE` `BACKUP_FAILED` `HASH_MISMATCH` …） | 本地故障，需要看日志 |

## 6. 失败与恢复

**同步任务的状态**只有一条出口（`service.mjs` 的 `#settle`），不会出现「既取消了又失败」这种两副面孔：

`queued` → `starting` → `hashing`（推送）/ `preparing`（拉取）→ `done`，
或者 `failed`（带 `错误码: 消息`），或者用户点取消时先 `cancelling` 再落到 `cancelled`。
取消优先：点了取消之后，即便底层连接是被掐断的，也不会被记成 `failed`。

进度字段（`bytes` 已传字节、`totalBytes` 总量、`detail` 当前文件）两个方向都有值：推送的字节数来自对端
`/progress` 的 `remote.*`，拉取来自本地 applier 平铺在顶层的同名字段，`service.mjs` 两种都认；
空事件不会把已经记下的数字清掉。

| 场景 | 处理 |
| --- | --- |
| 端口被占 | 启动前绑定探测（`server.mjs` 的 `start()`）；`EADDRINUSE` 报 `PORT_IN_USE` 并带上失败原因，换端口改 `server.port` |
| 对端离线 | 会话令牌 12 小时过期，之后要重新握手；设置页每 6 秒拉一次状态，连不上就显示不可达（不做后台自动重连） |
| 传输中断 | 接收端在 `<data>/syncs/<syncId>/` 留 `staging/` 与逐条 `journal.jsonl`；**没有断点续传**，重连后重新发起一次同步 |
| 应用中断 | 只有正常收尾才写 `journal.json`；只写到一半的批次在 `local/syncs` 里标成 incomplete，回滚时退回 `journal.jsonl`（结果带 `partial: true`），临时文件会在失败收尾时清掉 |
| 磁盘不足 | `/diagnostics` 的 `disk` 项报 **DSH 数据目录所在那块盘**的可用空间（< 2 GB 标 warn），只提示、不阻断同步；看的是同步真正写入的盘，不是用户主目录 |

## 7. 兼容性

- 协议带 `v1`，`/health` 返回 `app`、`protocol` 与 `version`；对端不是本插件或协议不符时报 `NOT_DSH_LINK`，
  UI 显示「对端不是远程互联服务，或协议版本不兼容」。
- 界面上每一句文案都必须走 `t('…')`：`test/i18n-guard.mjs` 会扫描 `client.js`，字典之外的字符串里出现中文就报错（注释例外），同时核对中英键集合、占位符（`{n}` / `{size}` / `{time}`）一致，以及 `t('…')` 用到的键都存在。
- 插件不碰 DSH 内部 API：host 半只用 `ctx.get('webServer')`（`export const inject = ['webServer']`，
  没有它插件不会加载），client 半只用 `ctx.slots` 与 `locale`，缺失时设置页不会出现「远程互联」分区。
- Windows / macOS / Linux 均可运行；路径处理一律走 `node:path` 与 `fileURLToPath`。
