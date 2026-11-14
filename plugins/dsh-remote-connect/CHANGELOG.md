# Changelog

所有值得注意的变更都记在这里。版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## 1.0.22 — 2026-11-15

### 修复

- **点名补装一个不存在的插件，过去会回「成功」**：`installPluginDeps(['no-such-plugin'])` 以前返回 `{ok: true, results: []}`——什么都没做，却说成了成功。现在返回 `unknown: ['no-such-plugin']` 且 `ok: false`。
- 依赖本来就齐全的插件会出现在 `skipped` 里，不再和「安装成功」混在一起（结果仍为空、`ok` 为 true）。
- 超时被我们自己掐断时，过去报成 `EXIT_null`（看不懂），现在报 `TIMEOUT`；`timeoutMs` 也夹到 5 秒–30 分钟，调用方传 0 或负数不再变成「立刻 SIGKILL」。

### 新增

- `test/deps.mjs` 扩到 7 项断言，新增三项：点不存在的插件 → `unknown` 且 `ok=false`；已齐全的插件 → `skipped`；**超时**——把假 `npm`（睡 30 秒）放进 PATH，预算被抬到 5 秒下限，于是必然由插件自己掐断并报 `TIMEOUT`；另外补了一条真失败（离线依赖）→ `EXIT_<code>` 且 `ok=false`。

## 1.0.21 — 2026-11-15

### 修复

- **`peers.json` 里混进怪记录会让插件起不来**：`load()` 过去只判断「是不是数组」，于是 `[null]`、字符串、端口 0 的记录会一路带进 `list()` 并抛 `TypeError`，`/status` 从此 500。现在载入时逐条收窄：缺 `host` 或端口不在 1–65535 的丢掉，字段超长截断，`scheme` 只认 `http`/`https`，重复 id 去重。
- 整个文件不是数组（例如被别的程序写成对象）时，挪成 `peers.json.broken-<时间戳>` 再从空的开始——以前会一直读到空列表但文件永远修不好。
- **写盘串行化**：并发 `upsert`／`patch` 现在排队写（每次写的是当时的快照），不会出现两个请求交错的临时文件与 rename。

### 新增

- `test/peers.mjs`：8 项断言——空库新增能读回、坏记录只丢坏的那几条、非数组文件留 `.broken-*`、**8 个并发 upsert 后文件是合法 JSON 且 8 条都在**、同机再连是更新不是新增、超长截断与 `scheme` 收窄、补丁与删除、列表不泄露 `password`/`token`/`sk`。已进 `run-all`（现 24 个套件）。

## 1.0.20 — 2026-11-15

### 修复

- **错误码到状态码的映射补齐**：以前只认十来种，`TOO_LARGE`（内容超上限）、`PATH_ESCAPE`（路径越界）、`PORT_IN_USE`、`NO_JOURNAL`、`KEY_MISMATCH`、`BAD_JSON` 之类全落到 500——界面看起来像「服务端坏了」，而实际上都是可以照着提示改的事。现在是一张固定表：401 / 403 / 404 / 409 / 400 / 413 / 502，其余才 500，且响应体始终带可读的 `error.message`。

### 新增

- `test/http-status.mjs`：6 项断言——认证 401、状态冲突 409、参数 400、太大 413、对端问题 502 与本地故障 500 的边界、未知码与空码回 500（不误伤）。
- `docs/ARCHITECTURE.md` 新增 §5.3「错误码 → HTTP 状态码」表。

## 1.0.19 — 2026-11-15

### 修复

- **取消同步会被改写成「失败」**：过去 `cancelTask` 只是把任务标成 `cancelled` 再掐断连接，可还在跑的 `#runSync` 随后 reject，catch 里又把它写成 `failed`——界面先显示「已取消」，两秒后变成「失败」，而且失败原因是一条 `NETWORK: 连接被中断`，看着像出了故障。现在任务只有一个收尾点 `#settle()`：取消优先，中断不算失败。
- 取消期间任务显示 `cancelling`（不是直接跳到 `cancelled`），并且重复点取消、对已经完成/失败的任务点取消都不会改写状态；掐连接失败（对端早就断了）也算取消成功。

### 新增

- `test/sync-cancel.mjs`：4 项断言——取消后终态是 `cancelled` 且没有 error、正常完成是 `done` 且事后取消不改写、真失败才写 `failed` 并带 `错误码: 消息`、没连上就失败的任务也会落终态。已进 `run-all`（现 22 个套件）。
- `docs/ARCHITECTURE.md` §6 增加了任务状态流转说明（`queued → starting → hashing/preparing → done`，或 `failed`，或 `cancelling → cancelled`）。

## 1.0.18 — 2026-11-15

### 修复

- **配置文件坏了不再被悄悄覆盖**：过去 `config.json` 解析失败会当成「第一次运行」，直接用默认值写回去——主人的连接密码就这么没了。现在抛 `CONFIG_BROKEN` 并原样保留文件，提示先备份再删；读不到（权限等）报 `CONFIG_UNREADABLE`。
- **读入时收拾类型与范围**：手改坏的配置（`port: "abc"`、`enabled: "false"`、`maxTotalMb: "lots"`、`kdf: null`、不认识的同步分类）不再带着进内存——端口夹到 1024–65535 或回默认、布尔按 `parseBool` 认、数值夹范围、未知分类丢掉、`kdf.N` 必须是 ≥ 默认值的 2 的幂（手改小了不会悄悄降低强度）。
- 密码太短/过长改成 `BAD_INPUT`（以前是无 code 的 `Error`，HTTP 上会变成 500）；`index.js` 的 `statusFor` 增加 `BAD_INPUT → 400`。
- 连接串解析加校验：空串、缺 `dshlink://`、没有主机、端口不是 1–65535 都给 `BAD_INPUT` 与可读提示，不再把 `NaN` 端口往下传。

### 新增

- `test/config.mjs`：8 项断言——首启生成完整配置与密码形状、坏 JSON 报错且**原文件字节不变**、合法但非对象也拒绝、手改坏的类型/范围被收回、`patch` 夹范围且拒绝未知分类、密码太短 `BAD_INPUT` 且改密码会换 salt、连接串往返、坏连接串的可读提示。已进 `run-all`（现 21 个套件）。

## 1.0.17 — 2026-11-15

### 变更

- `host/frames.mjs` 的编码器改名 `FrameEncoder` → `FrameEncoderTransform`，和 `FrameDecoderTransform` 对称；`peer.mjs`、`server.mjs` 的 import 与调用点同步。行为没变，只是这个名字之前在代码里两种叫法混着用。

### 新增

- `test/frames.mjs`：9 项断言——单帧往返、一次塞多帧按序全解、**切在任意字节边界（1/3/7/64 字节）都能拼回来**、多块输入经 Transform 后逐字节一致、密文改一个字节解不出、帧序号被换（重放/乱序）解不出、声明长度超 8 MB 直接报错、半截帧不许当正常结束、空流不产生输出。已进 `run-all`（现 20 个套件）。
- 这意味着传输层不再是「测过端到端就算测过」：它自己那条 AAD 校验（把帧序号绑进 AAD，重放就解不开）现在有独立断言盯着。

## 1.0.16 — 2026-11-15

### 修复

- **推送前先对账**：过去对端要传多少是不看的——推几个 GB 上来、传到一半才被上限拒绝。现在 `/apply/prepare` 会核对对端声明的 `totalBytes`，超了直接回 413 `TOO_LARGE`（消息里带两个数字）；同时在响应里回一个 `maxTotalBytes`，客户端 `push()` 拿到后如果发现自己要传的更多，**一个字节都不发**就报错。
- 进度轮询由固定 700ms 改成**退避**：700ms 起，每次乘 1.6，最多 3 秒一次；推送结束（含异常）立刻清掉定时器，不会在后台继续敲对端。一段 10 分钟的推送过去会多发上千个进度请求。
- 清掉误导人的 `#limitFor()`：它写着 `/apply/` 有 1 GB 请求上限，但那几条路由是流式上传，根本走不到这个分支——真正的上限是 `sync.maxTotalMb`，且已经在 `prepare` 阶段核对。

### 新增

- `test/push-guard.mjs`：3 项断言——对端上限小于要传的量时连 PUT 都不发（也不开进度轮询）、上限够用时正常推送且 `x-dl-total` / `x-dl-token` / `x-dl-mac` 齐全、推送结束后 2 秒内不再有进度请求（证明定时器真的停了）。已进 `run-all`（现 19 个套件）。

## 1.0.15 — 2026-11-15

### 修复

- 总量上限现在**在哈希之前**就判定：清单本来就带 `totalBytes`，过去却是「把每个文件都 sha256 一遍、累计超过 8 GB 才报错」，同步一个超大目录会白算几分钟再失败。新增 `maxTotalMb` 参数（默认 8192，`service.mjs` / `server.mjs` 从配置 `sync.maxTotalMb` 传入）。
- 读文件失败给可读错误：扫描之后、读之前文件被删或被独占锁住时，过去是裸 `ENOENT` 冒到 HTTP 层，现在是 `READ_FAILED`，消息里带路径与系统错误码。
- 哈希缓存载入时按上限裁剪（缓存文件可能被旧版本写成 20000 条以上），避免长期运行后内存里多出一份超量映射。

### 新增

- `test/pack.mjs`：6 项断言——缓存键形状与读写、载入裁剪、哈希与内容一致且清单不带绝对路径、缓存命中不重算、总量超限早失败（且一条哈希都没写进缓存）、`packStream` 产出确实是 gzip 包着的 tar。已进 `run-all`（现 18 个套件）。
- `docs/ARCHITECTURE.md`：写明哈希缓存位置（`<data>/hash-cache.json`）、上限 20000、键为 `路径|大小|mtime`，以及这是启发式——外部工具改了内容又还原 mtime 时会命中旧值，删缓存文件即可强制重算。

## 1.0.14 — 2026-11-15

### 变更

- `host/discovery.mjs`：新增 `sanitizePeerReply()`——局域网里谁都能往 UDP 端口发包，过去一个回复里 `port: 0`（或字符串）就会变成端口为 `NaN` 的「对端」条目，点连接才发现连不上。现在 `m`/`v` 必须匹配、`id` 非空且截 64 字符、端口必须是 1–65535 的整数、`name`/`platform`/`version` 一律截断，缺字段整条丢掉；`broadcastOf` 也导出以便测试。
- 探测发包加了保护：非法广播地址（`send` 会同步抛）不再打断整轮扫描。

### 新增

- `test/discovery.mjs`：7 项断言——广播地址计算、`lanBroadcasts()` 全是合法 IPv4、回复字段校验矩阵（含超长截断）、`start()` 只应答合法探测（垃圾包与错误版本号都不理）、`scan()` 从真实回环 UDP 里只收合规条目并丢掉端口非法的那条、非法广播地址不抛错。已进 `run-all`（现 17 个套件）。

## 1.0.13 — 2026-11-14

1.0.12 在 ubuntu 的 CI 上红了：`safeJoin` 的 Windows 保留名检查（`CON`、`LPT1` 之类）只在 `process.platform === 'win32'` 时生效，而测试无条件断言这些名字必须被拒绝——Linux 上 `CON` 是合法文件名，断言自然失败。

### 修复

- `test/pack-safety.mjs`：Windows 保留名的两条断言改为只在 Windows 上加（`if (process.platform === 'win32') bad.push('CON', 'lpt1.txt')`）；其余断言（`../`、绝对路径、盘符、NUL 等）平台无关，照旧全跑。代码本身没有改动——`safeJoin` 的行为一直是对的，红的是测试的假设。

## 1.0.12 — 2026-11-14

同步入口的安全边界做了一次复核，并补上守卫测试。代码本身没有漏洞，但以前这些边界**没有一条被测试盯着**——现在有了。

### 新增

- `test/pack-safety.mjs`：把别人发来的 tar 当成不可信输入，逐条钉住六件事——
  1. `safeJoin` 拦下 `../`、`a/../../b`、绝对路径、盘符、`./`、空段、NUL、Windows 保留名、超长路径，正常路径仍落在根内；
  2. 归档里带 `../` 的名字 → `PATH_ESCAPE`，且根目录外**没有任何文件**被写；
  3. 目标已存在的目录不会被文件覆盖（目录和里面的文件都在）；
  4. tar 里的符号链接/硬链接条目被跳过，后面的普通文件照常解析；
  5. 超过 `maxTotalMb` → `TOO_LARGE`；
  6. 正常归档能落地且内容正确（对照组，防止前几条只是「一律拒绝」）。
- 另有一条「目标是符号链接就跳过」的断言：没有 `SeCreateSymbolicLink` 权限的账户建不了链接，这种情况记为 **SKIP（不算通过）**，不会假装验证过。已进 `test/run-all.mjs`（现在 16 个套件）。

### 文档

- `SECURITY.md` §6 补上路径闸门、链接与目录条目、总量上限、半途批次可回滚这几条——以前它们只存在于代码里。

## 1.0.11 — 2026-11-14

把回滚路径走了三种情况（正常批次 / 半途失败 / 什么都没写成），发现最需要撤销的那一种以前是死路。

### 修复

- **半途失败的同步以前回滚不了**：`rollback()` 只读 `journal.json`，而它只在正常收尾时才写。同步传到一半失败时，已经落地的那些文件既撤不掉、也看不见（`local/syncs` 里只是一条 incomplete）。现在 `journal.jsonl` 被当成退路——逐行记录正好够还原已落地的文件，回滚结果带 `partial: true`，回滚后补写一份 `journal.json`，免得下次又走同一条分支。
- **失败时残留临时文件**：写入过程中的 `*.dshlink` 临时文件现在会被记下来，失败收尾时统一清掉（以前超限或校验失败时会留在目标目录旁边）。
- 删掉 `apply.mjs` 里没人调用的 `hashOf()`。

### 新增

- `test/rollback.mjs`：4 项断言——正常批次（改过的还原、新建的删掉）、只有 `journal.jsonl` 的半途批次（能回滚且标 `partial`）、同一批次不能滚两次、什么记录都没有时给 `NO_JOURNAL`。已进 `test/run-all.mjs`（现在 15 个套件）。

## 1.0.10 — 2026-11-14

对着 `peer.mjs` 把「会话过期以后会怎样」走了一遍，走出两个真问题：一个会让人**只能手动重连**，一个让**超时被误报成网络错误**。

### 修复

- 会话过期后本地缓存不清：`ensureConnected()` 只看 `peer.session` 有没有，不看它是否过期；`#jsonFrom()` 拿到 401 也只抛错不清理。结果是进程一直拿着作废的 token 反复撞 401，用户必须手动断开重连才恢复。现在新增 `sessionUsable()`（留 30 秒余量），过期或收到 `UNAUTHORIZED` / `SESSION_EXPIRED` 时立刻把本地 session 置空，下一次操作自动重新握手。
- 超时被压成 `NETWORK`：`#request()` 把**所有** error 事件都包装成 `NETWORK`，连它自己 `req.destroy(new AppError('TIMEOUT'))` 造出来的超时也被吞掉。`index.js` 的 502 映射里那条 `TIMEOUT` 因此从来没被命中过。现在 `AppError` 原样透传，只有真正的 socket 错误才转成 `NETWORK`。

### 新增

- `test/peer-session.mjs`：起一个只按脚本回答的假对端，5 项断言——过期判定的边界、正常响应不动会话、401 之后会话被清空、对端不回话时错误码是 `TIMEOUT`、端口没人监听时是 `NETWORK` 且提示可读。已进 `test/run-all.mjs`（现在 14 个套件）。

## 1.0.9 — 2026-11-14

继续拆 `server.mjs`（650 → 607 行）：把跟 HTTP 无关的那一小撮安全逻辑搬出去，顺便让它第一次能被单独断言。

### 变更

- 新增 `host/guard.mjs`：`clientIp()`、`sanitizeDevice()`、`FailureTracker`（失败计数与锁定）、以及四个常数 `LOCK_AFTER(10)` / `LOCK_MS(10 分钟)` / `NONCE_WINDOW_MS(10 分钟)` / `CLOCK_SKEW_MS(5 分钟)`。`server.mjs` 里原来那三个私有方法（`#blocked` / `#registerFailure` / `#clearFailures`）和两个末尾小函数都删掉了，改成 `this.guard.xxx()`。
- 行为没变：仍然是「连续失败 10 次锁 10 分钟、成功即清零、到期顺手丢记录」。

### 新增

- `test/guard.mjs`：8 项断言——`clientIp` 去 IPv4-mapped 前缀且拿不到地址不炸、`sanitizeDevice` 只留四个字段并按长度截断、第 9 次失败还不锁第 10 次才锁、锁满 10 分钟自动解开且记录被清掉、不同 IP 各记各的、四个常数与 `SECURITY.md` 里的数字一致。已进 `test/run-all.mjs`。
- `test/security.mjs` 改成从 `host/guard.mjs` 读锁定与签名窗口的常数（它们搬家了），并额外断言 `server.mjs` 的 `#prune` 确实用了 `NONCE_WINDOW_MS`。

### 文档

- `docs/ARCHITECTURE.md` 的进程图按现在的模块重画：加上 `Guard`，并把框线宽度全部对齐（以前有几行差 1–2 格，中文全角字符也算过之后就不再错位）。
- 根 `README.md` 目录树补上 `guard.mjs`。

## 1.0.8 — 2026-11-14

`SECURITY.md` 里那些数字（scrypt 参数、挑战 60 秒、会话 12 小时、锁 10 分钟、备份 5 批……）以前全靠人记着别写错，现在有一条测试把它们钉在代码上。

### 新增

- `test/security.mjs`：8 项断言逐条对账——KDF 参数、密码形状（3 组 ×4 字符）、挑战/会话 TTL、时钟偏移与失败锁定、nonce 窗口、备份保留批数、「改密码会清空会话」这条承诺、以及文档列的每一条排除规则在 `host/inventory.mjs` 里都能找到实现。已进 `test/run-all.mjs`。

### 修复

- `SECURITY.md` 补齐两处以前只靠口口相传的内容：连接密码是 3 组 4 字符（字母表不含 I / O / 0 / 1）；改密码除了清会话，还会丢弃主密钥缓存并断开已有出站连接。
- `SECURITY.md` 的「默认不传」清单补上 `.svn/`、`.hg/`、`__pycache__/`、`.cache/`、`.next/`、`.turbo/`、`.venv/`、`venv/`、`coverage/`，以及 `*.swp`、`*.lock`、`.DS_Store`、`Thumbs.db`——这些代码里本来就排除了，只是没写进文档。

## 1.0.7 — 2026-11-14

1.0.6 在 Windows 上是绿的、在 CI 的 Ubuntu 作业上是红的——测试里混进了「必须有 netstat 才有意义」的断言。这一版把它按平台分开，并且顺手修了缓存逻辑的一个真问题。

### 修复

- `netstatListeners()` 只在 Windows 上真的去跑 `netstat.exe`；其它平台直接返回空表，不再每 2 秒起一次注定失败的进程。
- 缓存改成用 `valid` 标记判断，不再靠 `map.size`——空表也是有效结果。以前「确实没人监听」这种正常情况会被当成缓存未命中，反复重探。

### 变更

- `test/port-scan.mjs` 里「挑出的空闲端口确实不在监听表里」这条只在 `win32` 上跑；其它平台改断言「回落空表」。

## 1.0.6 — 2026-11-14

继续拆巨型文件：把「谁在听这个端口」从手机通道的启停编排里拿出来，为它单独配了测试。

### 变更

- 新增 `host/port-scan.mjs`：`parseNetstat` / `netstatListeners` / `invalidateNetstat` / `listenerPids` / `isBridgeCmd` / `pickFreePort`。`phone.mjs` 从 739 行降到 687 行，只留目录探测、启停编排、状态与 HTTP 接口。
- `parseNetstat` 是纯函数（输入 netstat 文本、输出 `Map<端口, pid[]>`），所以解析规则第一次能被直接断言，而不必真起一个 `netstat.exe` 去猜。

### 新增

- `test/port-scan.mjs`：10 项断言——IPv4/IPv6 同端口多 pid 去重、UDP 与 `ESTABLISHED` 不算监听、脏行（端口 0 / pid 0）丢弃、空输入不炸、`server.mjs` 认领规则（含大写与反斜杠）、缓存有效期内的实例复用、`listenerPids` 对空闲端口返回空数组、`pickFreePort` 挑出的端口确实不在监听表里。已进 `test/run-all.mjs`。

## 1.0.5 — 2026-11-14

纯内部整理：把任务表从 `service.mjs` 里搬出来，行为不变，但从此有测试盯着。

### 变更

- 新增 `host/tasks.mjs`：`TaskTable` / `newTask` / `taskView` / `MAX_TASKS`。任务表本来就只是「内存里一张按开始时间淘汰的 Map」，和配对、同步、回滚混在一个 563 行的文件里既难读也难测。`service.mjs` 现在只负责编排（523 行），任务表自己管自己。
- 淘汰逻辑从「每次插入时现场 `[...map.values()].sort()`」改成单次线性找最老的一条——40 条的规模下差别可以忽略，但不必为一次插入排一次序。
- 顺手删掉 `service.mjs` 里已经没人用的 `rid` 引入。

### 新增

- `test/tasks.mjs`：8 项断言盯住默认值、对外视图字段、上限淘汰（看 `startedAt` 而不是插入顺序）、`recent(n)` 顺序、未知 id 返回 `null`。已进 `test/run-all.mjs`。

## 1.0.4 — 2026-11-14

设置页现在能只用键盘走完，读屏器也知道现在在哪个标签、哪些开关是开的。

### 新增

- 标签栏按 ARIA tabs 模式补齐：`role="tablist"` / `role="tab"` / `role="tabpanel"`，`aria-selected`、`aria-controls`、`aria-labelledby` 三对关系对得上；只有当前标签在 Tab 序列里（roving tabIndex），`←` `→` `Home` `End` 切换并跟着移焦点。
- `test/a11y.mjs`：用一个自带的小渲染器把组件树摊平检查上面这些（含「挂了 onClick 却既不是按钮也没有 role」的裸元素），已进 `test/run-all.mjs`。

### 修复

- 提示条（toast）改成 `role="status"` + `aria-live="polite"`，读屏器会念出来；此前它只是块会消失的 div。
- 加载态补 `role="status"`、转圈图标 `aria-hidden="true"`，错误态用 `role="alert"`（会打断，适合错误）。
- 忙碌中的按钮加 `aria-busy="true"`；`dlk-dot` 装饰点标 `aria-hidden`。

## 1.0.3 — 2026-11-14

安装器能自己说清楚参数了，也终于有了测试——它当年那版「只给 `--purge` 却反而又装一遍」的 bug，正是因为没有测试才活到发版。

### 新增

- `scripts/install.mjs` 支持 `-h/--help`（完整用法与副作用说明）和 `-v/--version`。
- `test/install.mjs`：在临时目录造一个假 DSH_HOME，20 条断言覆盖 `--help`/`--version`/参数报错/`--dry-run` 不写盘/真装/重复安装幂等/`--uninstall` 保留文件/`--purge` 连目录删除。已挂进 `test/run-all.mjs`。
- `test/docs-guard.mjs` 第 7 项：文档里给用户照抄的 `#vX.Y.Z` 必须等于 `package.json` 的版本。

### 修复

- 拼错参数（例如 `--unistall`）不再被默默忽略，直接报「不认识的参数」并退出 1；`--dsh-home` 这类要取值的选项后面空着也会报错。
- `--purge` 会打印它实际删掉的目录；`--purge --dry-run` 打印「会删的目录」而不动手。
- 安装目标与包自身路径相同时拒绝执行（防止往发布仓自己头上装）。
- 找不到 profile 时给出可操作提示（先启动一次 DSH，或用 `--profile` / `--dsh-home` 指对地方），而不是只抛一句「找不到」。
- 包内 `README.md` 的安装命令还钉着 `#v1.0.1`，照抄会装到旧版本；已改成 `#v1.0.3`（新增的版本标签守卫就是为了不再漏这个）。

## 1.0.2 — 2026-11-14

装出来的包里文档自洽了：以前包内 `README.md` 链到仓库根的 README，安装后那个文件不存在。

### 修复

- 包内 `README.md` 改成自带安装命令与配置说明，不再依赖仓库里的其他文件；指向仓库的地方用绝对 URL。
- `test/docs-guard.mjs` 的链接检查只校验包内的相对链接——指向包外的链接安装后本来就没有，
  不该把用户装的包判红；输出顺带给出实际校验了几条链接。

## 1.0.1 — 2026-11-14

公开包里不再带任何一台具体机器的路径；文档与代码之间加了一道自动守卫。

### 修复

- `host/phone.mjs` 里去掉了写死的开发机路径（原回落里那条 `D:/…/phone-bridge`）。
  现在 `probeBridgeDir()` 依次看：`DSH_PHONE_BRIDGE_DIR` → `$DSH_HOME/phone-bridge` →
  `./phone-bridge` → `~/phone-bridge`，只认里面真有 `ensure-running.ps1` 或 `server.mjs` 的；
  一个都不中就返回第一个候选目录（界面显示「还没装手机通道」，不会抛 ENOENT）。
  `os.homedir()` 取不到时用 `try/catch` 兜住，容器里也不会炸。
- `scripts/install.mjs` 的 `--purge` 早先没被当成卸载开关（只给 `--purge` 会变成「安装」），
  现在是 `--uninstall || --purge`；`--dry-run` 的输出也改成「将要删」而不是「已删」。

### 新增

- `test/docs-guard.mjs`：六项文档守卫——运行时路由 vs `docs/ARCHITECTURE.md`、CHANGELOG 顶版本号
  vs `package.json`、`locale` 中英键集一致、代码里不许出现引号开头的绝对路径、
  `package.json` 的 `files[]` 每项存在、文档相对链接不坏。已挂进 `test/run-all.mjs`。
- `client.js` 里的 `DeviceLinkSection` 改名为 `RemoteConnectSection`，公开代码里不再留下旧插件的名字。

### 文档

- `README.md` 与 `docs/PHONE.md` 的路径优先级补上自动探测三级与「第一个候选目录」的兜底行为。
- `RELEASING.md` 改成占位路径（`<主项目>` / `<发布仓>` / `<DSH 安装目录>`），别人照着也能用。

## 1.0.0 — 2026-11-14

三个插件合并成一个包，对外只发这一个。

### 变更

- **合并**：`dsh-device-link` + `dsh-phone-bridge` 合并为 `dsh-remote-connect`；
  手机通道不再是「另一个插件装没装」的问题，而是同一个包里的 `host/phone.mjs`。
  之前 `index.js` 里那句 `import(new URL('../dsh-phone-bridge/index.js', import.meta.url))`
  只在本机把两个包装在相邻目录时成立，别人装了设备互联永远看到「手机通道插件未安装」——这条断了。
- **去掉 `dsh-prompt-inject`**：默认读 `~/.dsh/prompt-inject.md`，DSH 数据目录早已可以不在那里，
  大多数人也没有这个文件；注入系统提示词交给 DSH 自己的指令文件。
- **改名**：路由 `/dsh-device-link-api/*` → `/dsh-remote-connect-api/*`；包名、`APP_ID`、
  数据目录、日志名、CSS 资源、`cordis.patch.yml` 的 id 一并改为 `remote-connect`。
  设置页标题：设备互联 → **远程互联**。

### 新增

- **`bridgeDir` 可配置**：`host/phone.mjs` 里的桥接路径从硬编码常量改成
  `config.bridgeDir` / `config.dir` / 环境变量 `DSH_PHONE_BRIDGE_DIR` / 自动探测 / 第一个候选目录；
  对应测试 `test/bridge-dir.mjs`。
- **`installed()` / `installed` 字段**：手机通道页签能区分「没装 phone-bridge」和「装了但没起来」，
  前者给安装提示与它实际找的路径，后者才是错误。
- **`docs/PHONE.md`**：手机通道的目录要求、配置项、接口、状态字段、怎么停用。

### 继承自 0.1.0

- 设置页五页签（概览 / 连接 / 同步 / 手机通道 / 诊断），中英双语，跟随 DSH 主题。
- 互联服务默认 `8788/TCP`，占用自动顺延；UDP 广播发现同网段设备。
- 配对：scrypt + 挑战应答 + HKDF + HMAC 签名 + AES-256-GCM 帧加密，12 小时会话、
  nonce 防重放、10 次失败锁定 10 分钟。
- 同步：skills / rules / plugins / config / sessions / plugin-data 六类，双向预览与推送，
  逐文件 SHA-256、原子替换、覆盖前备份、整批 journal 与回滚。
- 默认排除依赖、缓存、日志、密钥、凭据，插件自身数据目录永久排除。
- 诊断：10 项环境自检、插件依赖体检与显式补装、结构化日志。
- 安装器 `scripts/install.mjs`：`--dry-run` / `--profile` / `--uninstall` / `--purge`，不重启 DSH。

### 文档

- `docs/ARCHITECTURE.md` 与 `SECURITY.md` 按代码逐条核对后重写：传输端点、30 条本机路由、
  密码生成规则（3 组 ×4 字符，字母表不含 I/O/0/1）、失败锁定（按 IP，10 次锁 10 分钟，无退避）、
  异常表（端口占用 / 对端离线 / 传输中断无断点续传 / 缺 `journal.json` 不可回滚 / 磁盘不足仅提示）。
- `README.md` 的 git 直装命令改钉真实发布提交，不再指向缺 `host/phone.mjs` 的旧提交。

### 测试

- `node test/run-all.mjs`：host 单测全绿；`test/client-smoke.mjs` 校验 153 个中英词条对齐。
