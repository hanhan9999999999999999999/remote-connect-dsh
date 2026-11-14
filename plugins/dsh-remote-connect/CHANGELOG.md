# Changelog

所有值得注意的变更都记在这里。版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

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
