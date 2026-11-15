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
- 「记住密码」的语义：`connect()` 读旧密码走 `peerStore.raw(id)`（`list()` 是对外视图，按设计不含 password）；不重输密码的重连会原样保留已存的密码，勾着「记住」时新密码覆盖旧的，**不勾时只在连接成功后**才清空——连接失败不改磁盘上的东西。

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
- 回滚时若某条目的备份已被 `backupKeep` 轮转清掉，结果里 `missing` 会计数（`journal.rollback.missing` 同步记下）——不会再把「没还原成」说成还原了。
- 对端发来的 `profiles/*/package.json`（`op: merge-profile`）如果不是合法 JSON 对象，整条跳过并计入 `skipped`：本机的 profile 不会被替换成坏文件。合并时只采纳 `dependencies` 与 `dsh.profile.bundles`，`name` 与 `private` 保持本机自己的。
- 内存里的批次状态最多留 20 条（`MAX_STATES`），更老的只存在磁盘上的 `<data>/syncs/` 里；DSH 连开几天不会一直挂着一串 state。

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

`host/status.mjs` 里有一张固定的映射表（`STATUS`，`index.js` 与 `host/server.mjs` 共用同一张），没登记的错误码一律 500——但响应体里一定带可读的 `error.message`。
分成五类，界面据此决定是「让你改点什么」还是「这像是坏了」：

| 状态码 | 错误码 | 含义 |
| --- | --- | --- |
| 401 | `BAD_PASSWORD` `LOCKED_OUT` `UNAUTHORIZED` `SESSION_EXPIRED` `MISSING_SIGNATURE` `BAD_SIGNATURE` `REPLAY` `CLOCK_SKEW` | 密码不对 / 被锁 / 会话失效 / 签名不对 |
| 403 | `KEY_MISMATCH` | 两边的会话密钥对不上（多半是改过密码） |
| 404 | `PEER_UNKNOWN` `TASK_UNKNOWN` `SYNC_UNKNOWN` `PACK_UNKNOWN` `NOT_FOUND` | 找不到这个对端 / 任务 / 批次 / 清单 |
| 409 | `NOT_CONNECTED` `NEED_PASSWORD` `NO_PASSWORD` `PORT_IN_USE` `SYNC_BUSY` `NO_JOURNAL` `ALREADY_ROLLED_BACK` | 现在做不了，但不是参数错 |
| 400 | `BAD_INPUT` `BAD_JSON` `NO_HOST` `METHOD` `CATEGORY` `EMPTY` `BAD_PLUGIN_ID` `PATH_ESCAPE` `VERSION_MISMATCH` `HASH_MISMATCH` `SIZE_MISMATCH` | 参数或内容不对 |
| 413 | `TOO_LARGE` `BODY_TOO_LARGE` | 内容/请求体超过上限（同步页可以改「同步上限」或分批） |
| 429 | `LOCKED` | 试太多次，先等一会儿 |
| 502 | `NETWORK` `TIMEOUT` `NOT_DSH_LINK` `BAD_RESPONSE` `BAD_ENVELOPE` `PHONE_BAD_RESPONSE` `NO_PORT` | 对端的问题，本机没坏 |
| 500 | 其余（`READ_FAILED` `CONFIG_BROKEN` `CONFIG_UNREADABLE` `BACKUP_FAILED` …） | 本地故障，需要看日志 |

落地（`/apply/<syncId>`）失败也走同一张表：路径越界 400、内容超限 413、批次不存在 404——以前这一条一律回 500，对端会以为自己或本机坏了，而它该改的其实是参数或分批（`test/server-auth.mjs`）。

## 6. 失败与恢复

**同步任务的状态**只有一条出口（`service.mjs` 的 `#settle`），不会出现「既取消了又失败」这种两副面孔：

`queued` → `starting` → `hashing`（推送）/ `preparing`（拉取）→ `done`，
或者 `failed`（带 `错误码: 消息`），或者用户点取消时先 `cancelling` 再落到 `cancelled`。
取消优先：点了取消之后，即便底层连接是被掐断的，也不会被记成 `failed`。

进度字段（`bytes` 已传字节、`totalBytes` 总量、`detail` 当前文件）两个方向都有值：推送的字节数来自对端
`/progress` 的 `remote.*`，拉取来自本地 applier 平铺在顶层的同名字段，`service.mjs` 两种都认；
空事件不会把已经记下的数字清掉。

「尽力而为」的分支（进度查询、哈希缓存写盘、恢复会话、记下入站设备）出错时**不许一声不响**：
`service.mjs` 用 `Logger.warnOnce(key, …)` 记第一条，同一个 key 之后不再重复，免得刷屏；
进度查询失败还会累加到任务的 `progressFailures`（任务视图里有这一项），
同步照样成功，但界面上说得出「进度可能不准」。这条规矩是 1.0.38 的教训：
一个 401 被 `catch {}` 吞掉，现场只表现为进度条不动，藏了两个版本。
界面这一侧同样要接住：`progressFailures > 0`、轮询连续失败 3 次、任务完成后的 `result`
都会在同步页显示一句人话（`test/task-fields.mjs` 守着「taskView 放行的字段界面必须真的读」）。

| 场景 | 处理 |
| --- | --- |
| 端口被占 | 启动前绑定探测（`server.mjs` 的 `start()`）；`EADDRINUSE` 报 `PORT_IN_USE` 并带上失败原因，换端口改 `server.port` |
| 对端离线 | 会话令牌 12 小时过期，之后要重新握手；设置页每 6 秒拉一次状态，连不上就显示不可达（不做后台自动重连） |
| 传输中断 | 接收端在 `<data>/syncs/<syncId>/` 留 `staging/` 与逐条 `journal.jsonl`；**没有断点续传**，重连后重新发起一次同步 |
| 应用中断 | 只有正常收尾才写 `journal.json`；只写到一半的批次在 `local/syncs` 里标成 incomplete，回滚时退回 `journal.jsonl`（结果带 `partial: true`），临时文件会在失败收尾时清掉 |
| 磁盘不足 | `/diagnostics` 的 `disk` 项报 **DSH 数据目录所在那块盘**的可用空间（< 2 GB 标 warn），只提示、不阻断同步；看的是同步真正写入的盘，不是用户主目录 |
| 流中途失败 | 落地失败（路径越界、哈希不符、超限）或推送被对端提前拒（413/401）时，那条 `res` / `source` 会被 `destroy` 掉——否则对端还在往外传、本地还在把文件读完，socket 一直挂在 agent 池里。解码与解压这两环统一走 `frames.mjs` 的 `decodeFrames()`（收、发两侧共用）；发送侧打包用 `pipeline()` 而不是 `.pipe()`，源文件在打包途中消失会变成一个正常的失败，而不是未捕获异常把进程带走（`test/peer-streams.mjs`、`test/frames.mjs`、`test/pack.mjs`） |
| 对端半死不活（发完响应头就不动） | 请求侧只负责拿到响应头，读内容在 `#jsonFrom()`：那里盯着 socket 超时的标记，读 body 阶段被掐断报 `TIMEOUT`「对端迟迟没有把内容发完」；半路真断开报 `NETWORK`。以前这两种都会变成裸 `ECONNRESET / aborted`，到路由层认不出错误码就成了 500「服务端坏了」（`test/peer-body.mjs`） |
| 对端一直往外吐内容 | 单个 JSON 响应上限 64 MB（`peer.maxJsonBytes`），超了立刻 `res.destroy()` 并报 `BAD_RESPONSE`「对端返回的内容超过 N MB，已中止」——`/syncs` 这类接口要是回一份坏数据，不能让它把内存吃光 |
| 连上来却什么都不发 | `requestTimeout = 0` 是故意的（大包要传很久，不能按总时长掐），换来的是**空闲超时**：连接上 `idleMs`（默认 120 秒）没有任何数据往来就 `socket.destroy()` 并记一条 warn。同步期间一直有数据在走，不会被误杀（`test/server-limits.mjs`） |
| 连接数被灌满 | `maxConnections`（默认 128）——这是个给对面一两个人连的 P2P 服务，正常人只开几条；到上限时多出来的连接直接被拒，并记一条 warn 带对端地址，而不是让端口把文件句柄耗光（`test/server-limits.mjs`） |
| 同步途中断开或删掉那台设备 | 它名下的任务统一走取消（`cancelled`，不是 `failed`）并掐断连接，否则任务会一直停在「准备中」——设备都已经不在列表里了，用户也没地方点取消。任务对象在 `#runSync` 里留了一根 `abortNow` 线：即使对端已从 `clients` 里摘掉，取消照样能生效（`test/forget-cancel.mjs`） |
| 批次编号或备份路径越界 | 批次编号会拼进 `<data>/syncs/<id>`，而它是从对端请求里来的（`/rollback`、`/progress` 都带着它），所以先按 `^[A-Za-z0-9_-]{1,64}$` 校验，不合规报 `BAD_INPUT`；`journal` 里记的备份路径同样当不可信输入，出了数据目录就按「备份没了」处理（算 `missing`），不去复制别处的文件（`test/rollback.mjs`） |
| 端口记录与实际不一致 | 手机通道的端口被占后会自动顺延，但 `runtime/port.json` 有可能没写进去（目录只读、磁盘满）：桥接在 8900 跑着、记录还指 8899。顺延成功却没写成时返回 `portWriteFailed` + 一句 `warning`；`status` 在记录那个端口问不到服务时，会去监听表里认「命令行像 `server.mjs` 的那个进程」，认出来就报真实端口并标 `portMismatch`，认不出来才报未运行——不假装有服务，也不假装没服务（`test/phone-port-sync.mjs`） |
| 面板轮询把 `syncs/` 翻来覆去读 | 「最近批次」要逐个批次读 `journal.json`，而状态接口几秒一次。现在 `Applier.listRecent()` 有 2 秒缓存（`recentTtlMs` 可调），新增批次、落地完成、回滚都会立刻让缓存失效，`limit` 在缓存之上裁剪——批次再多轮询也不会越读越慢（`test/local-syncs.mjs`） |
| 断开时跟对端告别失败 | `/bye` 发不出去（对端已经关了、连接烂了）**不影响本地收尾**：先把 peer 从 `clients` 摘掉，再清掉 `peers.json` 里的 `token`/`sk`（密码保留），失败只记一条 warn。否则 token 会一直躺在磁盘上、界面一直显示已连接，用户只能靠重启摆脱它（`test/disconnect-hardening.mjs`） |
| 被排除的文件没人看得见 | 扫描结果以前只带最多 40 条明细、总数不出门，界面一个字都不说，勾了「包含凭据」也没法确认生效没有。现在清单里带 `excludedTotal` 与按原因代号（`secret` / `log` / `big`）分组的 `excludedReasons`，界面按当前语言翻出来；明细每条也带 `code`，点「看看是哪些」能展开具体路径（最多 40 条，多出来的用一句「还有 N 个没列出来」交代）（`test/inventory-excluded.mjs`） |
| 扫描统计在返回给对端时被吞掉 | `scanAll()` 早就算好了「跳过了多少、各是什么原因」，但 `/inventory` 的响应体是自己拼的一个固定字段清单（`summary`/`totalFiles`/`totalBytes`/`excluded`/`entries`），把 `excludedTotal` 与 `excludedReasons` 漏在外面——于是「有 N 个文件没进清单（凭据 · 日志 · 超大）」这句话只有自己扫自己时才出现，从对端拉清单永远是 0。现在两个字段一起回，且没有跳过时也在（值为 0 / 空对象）（`test/inventory-wire.mjs`） |
| 批次建了却一个字节都没开始 | 两条这样的路：①我拉取时对端在开下载流之前就失败（`prepare` 已建批次，本地没人收）；②我自己推送时对端已经建好批次、我这边没发出去（`PUT` 直接断）。以前这两种都会在对端或本机留下一个永远停在「接收中」的批次——`#trimStates` 只收 `done`/`failed`，面板上挂着一条永远不动的记录，用户也没地方取消。现在 `Applier.discard()` 把它落成 `failed` 并记原因，拉取两侧各自收尾；推送失败时顺手发一条 `DELETE /apply/<syncId>?reason=…` 让对方收掉（这条是尽力而为，失败不盖住原始错误）（`test/apply-discard.mjs`、`test/server-auth.mjs`） |
| 日志文件写不进去 | `Logger` 的写盘流以前没挂 `error` 监听——日志目录不可写（盘满、目录被删、U 盘拔掉）时 Node 会把异步的 error 升级成未捕获异常，**整个 DSH 跟着退出**，而代码注释还写着「logging must never throw」。现在 `error` 有监听：记下原因、关掉这条流、在内存里留一条「之后只留在内存里」的警告（只一条，不刷屏），日志本身继续往 ring 里走；积压超过 `maxPendingBytes`（默认 4 MB）时弃掉写不进去的行并计数，不会把内存吃光；`close()` 之后不再重开文件（`test/logger.mjs`） |
| 一个读不了的子目录拖垮整次扫描 | walk() 以前把 opendir 的错（权限不足、被别的程序锁住、路径过长）原样抛出去——用户看到的是整个分类「扫描失败」。现在这类错只记一笔「读不了（权限不足）」（code: denied），继续扫别的目录；stat 失败、迭代途中目录被删也一样记一笔而不是静默跳过。目录递归另加 MAX_DEPTH = 64 的深度上限，超了就整支算作「目录层级太深」（code: deep）。两者都进 excludedTotal/excludedReasons 与可展开的明细，界面那句话也从「已按规则跳过」改成「有 N 个文件没进清单」（`test/inventory-read-errors.mjs`） |
| 对端在握手应答里乱写 | 握手应答（`/hello` 回的 `salt`、`serverNonce`、`kdf`）是**对端说的**，本机以前照着算：少一个字段就是 `Buffer.from(undefined)` 的 TypeError，`kdf.N` 报个十亿就让本机去申请一个不存在的体积。现在先收一遍——`salt`/`serverNonce` 必须是 16–64 字节的 base64，`kdf` 必须是对象、`N` 是 16384–1048576 之间的 2 的幂、`r`≤32、`p`≤16，且 `128*N*r` 不超过 512 MB，`keylen` 一律按 32 走；不合法就 `BAD_RESPONSE` 说清哪个字段不对（`test/handshake-guard.mjs`） |
| 没带令牌就发 POST | 先把令牌本身查一遍（有没有、过没过期），再决定要不要读 body。以前是先读 body 再验身份，128 条连接 × 4 MB 上限就是半个 GB 的内存，谁都能凑出来（`test/server-auth.mjs`） |
| 重放表与失败计数被人灌爆 | 这两张表以前都没有上限。重放表（nonce）只在「超过 5000 条」时清一次过期的——要是十分钟内真来了五千多个不同 nonce（一个已连上的对端就能做到），那次清理一条都删不掉，于是**每个请求都要把整张表扫一遍**，表还继续涨；失败计数则按来源地址一条条往里堆、永不清理，一个扫描器扫一晚上就能把内存吃掉。现在两者都在 `host/guard.mjs` 里带硬上限：`NonceStore`（上限 20000、过期清理按秒摊销、到顶挤掉最老的，代价是「极短时间内来两万个请求」时最老那批不再防重放）、`FailureTracker`（上限 10000、先清「最后一次失败已经超过锁定期」的记录、再挤最老的，**正在锁着的不挤**）。会话与挑战的清理也从「重放表超过 5000」改成 30 秒最多一次的定时清理；两个上限都能通过 `new LinkServer({ nonceMax, failureMax })` 覆盖（`test/guard-limits.mjs`） |
| 落地时的「条数」没有上限 | 字节数早就封顶（`maxTotalMb`），条数却没有：对端发几百万个 0 字节文件，一个字节的上限都碰不到，照样能把 `backups/`、`journal.jsonl` 和 inode 撑爆。现在 `applyStream` 从头数条目，超过 `sync.maxFiles`（默认 200 万条上限内的 20 万）就抛 `TOO_MANY_FILES`（HTTP 413，不是「服务端坏了」的 500），批次落成 `failed` 并写清原因；配置里的 `maxFiles` 走同一套夹取（1–2000000），`/config` 也能改（`test/apply-files.mjs`） |
| 把整串连接串粘进「地址」 | 面板上就摆着 `dshlink://192.168.1.5:8788?name=…&pwd=…`，旁边还有复制按钮——拿到它的人自然会整串粘进「地址」。以前这一栏一律当主机名发出去，于是去连一个叫 `dshlink://…` 的主机，报一句 DNS 找不到，人还以为是对方没开机。现在 `parseHostInput()` 按人真的会填的样式读：只写主机、`主机:端口`、带 `http://` 前缀、末尾多余斜杠、以及整串 `dshlink://`（协议头大小写都认，里面的端口/密码/备注名一并取出来，链接里没写的才用手填的）；含空格、带路径这类明显不对的当场提示「这个地址不太对」并且不发请求（`test/client-host.mjs`） |
| 填错的端口被悄悄换成默认值 | 两处填端口的地方以前都写 `Number(port) || 8788`：输入框里敲 `abc`、敲 `0`，`Number` 得到 `NaN` 或 `0`，于是被悄悄换成 8788，界面还挺高兴地说「已保存」——用户以为自己改成了 A、实际保存的是默认值；连接表单里敲错端口也会安静地去连默认端口。现在统一走 `parsePort(raw, {min, max})`：只认 1–5 位纯数字（`'8788.5'`、`'0x22b4'`、`'8e3'` 一律不认），监听端口要 1024–65535、对端端口 1–65535，判不过就当场提示「端口要填 X–Y 之间的数字（现在是「你说的那个」）」并且一个请求都不发（`test/client-port.mjs`） |
| 出错的提示和「已保存」一个腔调 | 提示条以前一律 `aria-live="polite"`、4.2 秒消失：读屏软件会把错误排在当前朗读之后（用户可能已经点别的地方去了），连点两下同一个按钮还会把同一句念两遍，而错误提示跟成功提示一样转眼就没。现在错误走 `assertive`、停 9 秒，普通成功仍 `polite`、4.2 秒；同一句连续出现两次时把 `aria-live` 换成 `off`（对话框上照样看得见，只是不再念第二遍）；空消息直接不弹（`test/toast-a11y.mjs`） |
| 本地打包失败，上传悬在那里 | `push()` 用 `packStream(entries).pipe(编码器)` 接上传流，可 `.pipe()` 不转发错误：打包途中某个文件读不到时，那条 gzip 只是带着 error 结束，编码器既不结束也不报错——上传就一直挂着，直到 120 秒空闲超时，用户看到的是「对端迟迟没有响应」，其实是本地文件没了（与 1.0.34 修的那个「把进程抛死」是同一处毛病的另一面）。现在把 `pack` 的 `error` 转给编码器（包成 `READ_FAILED`），请求立刻失败，`#cancelRemote()` 顺手让对端收掉批次（`test/peer-streams.mjs` 第 4 项，3 秒内必须有结果） |
| 面板快照有一块取不到就整页空白 | `status()` 以前把配置、服务状态、对端列表、最近批次、任务表串成一条链取——其中任何一块抛错（配置损坏、网卡枚举失败、`peers.json` 坏了、`syncs/` 读不了）整份快照就是 500，面板一片空白，而最需要看面板的时候恰恰是配置坏掉的时候。现在每块单独兜住：坏的那块降级成空值（`config` 用形状一致的空壳 `emptyPublicConfig()`，其余空数组/`{running:false}`），原因进 `degraded: [{section, code, error}]`，其余照常显示；`init()` 自己失败也不抛，记一条 `init` 并返回可用空壳。界面在顶部渲染一条 `role="alert"` 的提示列出哪几块不准（文案 `status.degraded`）（`test/status-degraded.mjs`） |
| 停手机通道时按过期端口去杀 | `stopBridge()` 以前只按 `runtime/port.json` 里记的端口找进程：端口顺延过、记录没写成时一个 pid 都找不到，干等 12 秒报「进程仍在响应」，而服务其实在另一个端口好好跑着。现在先问记录端口，问不到就去监听表里认「命令行像 `server.mjs` 的那个进程」，按**实际**端口找 pid 并杀；返回值带上 `port` 与 `recordedPort`。另外顺序改成「先写暂停标记、再杀进程」，并且停止失败时会把暂停标记撤掉——否则服务还在跑、下次启动却不会自动起来，用户看到的是「明明在运行，重启之后就不见了」（`test/phone-stop.mjs`） |
| 一轮局域网探测被灌满 / 被拖住 / 关掉之后再也不会恢复 | `scan()` 的等待时间、目标列表、收多少台都没有上限：`timeoutMs` 直接进 `setTimeout`（`NaN` 会变成 1 ms，扫描立刻返回空表）、`extraHosts` 原样并进广播目标（可以传一万个地址）、收到的回复也不封顶（同网段谁都能往这个端口灌，一台机器 1.5 秒能塞进几十万条）。现在 `scanWindow()` 把等待收进 200–15000 ms，`sanitizeTargets()` 只认 IPv4 字面量、去重并封顶 64 个，收满 `maxPeers`（256）之后多出来的回复直接丢掉并记一条警告；第二轮补发（450 ms）在扫描提前结束时会被清掉，不再往已关闭的 socket 上发。另外 `start()` 以前在 UDP 套接字意外关闭后仍把 `this.socket` 留着，端口被别的程序抢走之后就永远「已经在跑」、再也不监听——现在 `close` 会把 `this.socket` 放开、记一条 warn，下一次 `start()` 能真的重新绑上（`test/discovery-limits.mjs`） |

## 7. 兼容性

- 协议带 `v1`，`/health` 返回 `app`、`protocol` 与 `version`；对端不是本插件或协议不符时报 `NOT_DSH_LINK`，
  UI 显示「对端不是远程互联服务，或协议版本不兼容」。
- 界面上每一句文案都必须走 `t('…')`：`test/i18n-guard.mjs` 会扫描 `client.js`，字典之外的字符串里出现中文就报错（`/* */` 注释例外——那是写给人看的文风，不会显示给用户；注释之外 CSS 里的中文照样会红），同时核对中英键集合、占位符（`{n}` / `{size}` / `{time}`）一致，以及 `t('…')` 用到的键都存在。
- 键盘可达：标签栏是 ARIA tabs 模式（roving `tabIndex` + 左右键/Home/End），开关与勾选是真 `button` 带 `aria-checked`，提示条与加载态各有 `role`；`.dlk-btn` / `.dlk-tab` / `.dlk-input` / `.dlk-switch` / `.dlk-check` / `.dlk-block` 都给了 `:focus-visible` 描边（宿主页面常把全局 outline 关掉），系统开「减少动态效果」时过渡全部停掉。`Btn` 会把调用方多传的属性原样摊到 `button` 上——以前只解构自己认识的几个，`ConfirmBtn` 的「Esc 撤防」根本挂不上去（`test/a11y.mjs`）。
- 插件不碰 DSH 内部 API：host 半只用 `ctx.get('webServer')`（`export const inject = ['webServer']`，
  没有它插件不会加载），client 半只用 `ctx.slots` 与 `locale`，缺失时设置页不会出现「远程互联」分区。
- Windows / macOS / Linux 均可运行；路径处理一律走 `node:path` 与 `fileURLToPath`。
