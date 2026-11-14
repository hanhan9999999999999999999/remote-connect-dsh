# Changelog

所有值得注意的变更都记在这里。版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## 1.0.39 — 2026-11-15

### 修复

- **「尽力而为」不再等于「一声不响」**：`Logger` 新增 `warnOnce(key, scope, msg)`（同一个 key 只记一条，避免刷屏），四处原本彻底静默的失败现在第一次就会留痕：
  - 进度查询失败：记一条 warn（带错误码），并累加到任务的 `progressFailures`（任务视图里可见）——同步照样成功，但界面上说得出「进度可能不准」。1.0.38 那个 401 就是被这句静默吞掉的，现场只表现为进度条不动。
  - 哈希缓存写盘失败：记一条 warn，并保持 `dirty` 等下次重试（以前写失败等于「缓存开着却每次都重算」，没有任何提示）。
  - 恢复记住的会话失败：按设备各记一条 warn（对端离线仍是常态，只是不再是「明明勾了自动重连却没连上」而毫无线索）。
  - 记下入站设备失败：按设备各记一条 warn（否则表现为「对方连上过，重启后列表里没有它」）。

### 新增

- `test/silent-failures.mjs`（5 项断言）：`warnOnce` 去重与级别、进度查询失败只记一条 warn 且同步成功、任务的 `progressFailures` 上报、缓存写盘失败保 `dirty`。
- `taskView` 增加 `progressFailures` 字段（`test/tasks.mjs` 的字段清单同步）。

## 1.0.38 — 2026-11-15

### 修复

- **带查询串的请求签名一直对不上**：客户端签名时把 `/progress?syncId=…` 整段算进去，服务端却只算 `url.pathname` —— 于是每一次进度轮询都是 401 `BAD_SIGNATURE`，而调用方把错误吞了（进度是 best-effort），现场表现成「进度条一直不动」，看起来像对端没在传。现在签名与验签都走 `host/sign.mjs` 的 `signatureBase()`，查询串算在内；`subscribe` 与 `/progress` 这类带参数的请求才真正可用。
- **`/health` 报的版本号一直是 1.0.0**：`host/util.mjs` 的 `VERSION` 常量长期没跟着 `package.json` 走，装的人分不清自己跑的是哪一版。现在同步到当前版本，并且 `docs-guard` 会比对这两个值，发版忘了改就直接红。
- **`x-dl-stream` 改成只认 `'1'`**：以前只要这个头存在（哪怕值是 `"0"`）就按「流式」签名；现在客户端与服务端口径一致。
- **签名头长度设上限**：`x-dl-nonce` / `x-dl-mac` 超过 128 字符直接拒。nonce 会进重放表，一个超大 nonce 就是一个能撑内存的把手。

### 新增

- `host/sign.mjs`：`signatureBase()` / `signRequest()` / `bodyDigest()`，签名与验签共用同一个函数拼字符串。
- `test/signature.mjs` 9 项：带查询串一致、老写法不一致（把这个错法记进断言）、改查询串即失效、无查询串对照组、方法/时间戳/nonce 各自影响签名、拼接格式稳定。
- `test/e2e.mjs` 加一条：连上之后直接请求 `/progress?syncId=e2e-none`，必须走到 `SYNC_UNKNOWN` 而不是 `BAD_SIGNATURE` —— 这是那个 bug 的现场复现。

## 1.0.37 — 2026-11-15

### 修复

- **坏信封不再从 `node:crypto` 抛出「Invalid IV length」这类消息**：`decryptJson()` 现在先校验 `iv`（12 字节）与 `tag`（16 字节），再解密；内容解不开时统一说「加密信封校验失败（内容被改动，或两端密钥不一致）」，里面不是合法 JSON 时单独说清楚。
- **帧长度在两种坏值上都立刻报错**：`FrameDecoder` 以前只挡住「太大」，声明长度为 0 会一路走到解码器才报「帧长度非法」；现在 `MAX_FRAME` 与最小长度（28）都在切帧时就检查，消息里带上具体字节数。
- **解不开的帧说清楚是第几帧**：以前直接冒 `Unsupported state or unable to authenticate data`，现在报「第 N 帧校验失败（内容被改动，或帧顺序不对）」。

### 新增

- `test/crypto-guard.mjs` 12 项：信封往返、非信封、iv/tag 长度不对、密文被改、换密钥、帧往返、帧太短、帧序号不对、声明长度 0 / 超大、多帧对照组。

### 文档

- `SECURITY.md` §8 补第 9 条已知限制：两个方向共用同一把会话密钥与同一套帧序号（能主动改写传输层的人可以把帧反射到另一个方向；按方向派生子密钥会破坏新旧版本互通，因此本版未改）。

## 1.0.36 — 2026-11-15

### 修复

- **头里的名字不再被悄悄截断**：`makeHeader()` 以前用 `block.write(name.slice(0, 100), …)`，超过 100 字节的部分会被 `Buffer.write` 默默丢掉——写出来的头与 pax 里的路径不一致，而且看不出来。现在超过 100 字节直接报错，长名字必须走 pax 扩展头。
- **数值放不进字段宽度时报错**：`octal()` 以前照样 `padStart` 再交给 `Buffer.write`，字段宽度不足时后几位被截掉（例如把毫秒当秒传进来的 `mtime`）；负数与 `NaN` 也会写出无意义的头。现在数值必须是有限的非负整数，且必须在字段宽度内。
- **长路径的退路名不再重复末尾字符**：以前是 `name.slice(-90).replace(…) + name.slice(-40)`，最后 40 个字符会被写两遍。现在按 UTF-8 字节从尾部截到 100 字节以内（不切断多字节字符），只作占位——真正的路径仍在 pax 里。

### 新增

- `test/tar-write.mjs` 6 项：超长名字被拒、100 字节边界正常、数值宽度溢出被拒、负数/NaN 被拒、长中文路径的退路名是「原名的尾部且不重复」、普通短路径对照组。

## 1.0.35 — 2026-11-15

### 修复

- **归档头的长度一律校验**：tar 头里的 `size` 必须是安全整数（含 base-256 形式写出的值），否则报「tar 头里的长度不合法」——以前一个 `0x80` 开头的长度能算出超过 2^53 的数。
- **pax / GNU 长名的元数据块上限 1 MB**：以前长度直接取自头里的 octal 字段，最大约 8 GB，接收端会照着往内存里攒——对端一个头就能把被连接方撑爆。现在超出即报「元数据块过大 / 长名块过大」。
- **pax 里的 `size` 必须是安全整数**：`abc` 会变成 `NaN`（解析器随后原地打转），`1e30` 会一直等下去；现在直接报「pax 里的长度不合法」。pax 的 `mtime` 不是有限数时回落到头里的值。

### 新增

- `test/tar-hostile.mjs` 5 项：pax 声明 8 GB、GNU 长名声明 8 GB、base-256 巨型长度、pax `size=abc`、正常 pax 小文件对照组。

## 1.0.34 — 2026-11-15

### 修复

- **打包途中源文件被删/被独占锁，会把整个进程抛死**：`packStream()` 以前是 `Readable.from(tarEntries(...)).pipe(createGzip())` —— `.pipe()` 不会把源上的错误传给下游，源上的 `'error'` 又没人接，于是 `ENOENT` 直接成了未捕获异常（实测 `UNCAUGHT: ENOENT: no such file or directory, open '…\skills\b.md'`）。改成 `pipeline()`：错误经 gzip 传到调用方，同步任务正常落成 `failed`。
- **这种情况的错误信息原先不可读**：现在 `tarEntries` 会把它换成「读不到 `skills/b.md`：ENOENT（可能在打包期间被删除或被其它程序占用）」。

### 新增

- `test/pack.mjs` 加一项：打包途中把源文件删掉，`packStream()` 必须 reject（而不是把进程抛死）。

## 1.0.33 — 2026-11-15

### 修复

- **被连接的一侧，坏帧流同样会把进程抛死**：服务端接收上传（`#receiveApply`）也是 `req.pipe(new FrameDecoderTransform(...)).pipe(createGunzip())`，那两环没有 `error` 监听——和 1.0.32 修的是同一类问题，只是发生在「收」的那一头。对端发来一段解不开的帧，DSH 一样会被整个抛掉。
- **上传失败后那条流没人关**：落地报错（路径越界、超限……）时对端还在往外传，`finally` 里补 `link.destroy()`。

### 变更

- 「解密 → 解压」这条链路抽成 `host/frames.mjs` 的 `decodeFrames(source, key)`，返回 `{ stream, destroy() }`；`host/peer.mjs` 的 `pull()` 与服务端 `#receiveApply` 共用一份实现——免得两边各写一遍、各漏一处（这次就是漏在服务端）。

### 新增

- `test/frames.mjs` 加两项：`decodeFrames` 正常解回原样（线上顺序是「加密帧套着 gzip」）、坏帧时报错而不是把进程抛死。

## 1.0.32 — 2026-11-15

### 修复

- **拉取失败时，那条下载流没人关**：`applyStream` 一抛错（路径越界、哈希不符、超过上限），局部的 `res` 就留在那儿——对端还在往外传，socket 停在 agent 池里，几 GB 的包会在失败之后继续往本机淌。现在 `finally` 里必定把它 `destroy` 掉。
- **解不开的帧流会把整个进程抛死**：解码 `FrameDecoderTransform` 与 `gunzip` 这两环没有 `error` 监听，对端发来一段解不开的帧就 `emit('error')`，没人接，DSH 进程直接被抛（实测 `Error: 帧过大`）。现在把它转成 `tar` 上的错误，交给 `applyStream` 的 `pipeline` reject 出去。
- **推送被对端提前拒了，本地读流还在读**：413/401 之后 `source` 会继续把几个 GB 的文件读完再丢。`finally` 里补 `destroy()`。

### 新增

- `test/peer-streams.mjs`（3 项断言）：落地失败时对端必须看到连接被关掉、成功路径也要把流收干净、对端发坏帧时报错而不是崩进程（第三条正是上面第二个缺陷暴露出来的）。

## 1.0.31 — 2026-11-15

### 修复

- **「记住密码」在每次重连时被悄悄清空**：`connect()` 用 `peerStore.list()` 去找旧密码，而 `list()` 是对外视图、按设计不含 `password`，所以旧密码永远是 `undefined` —— 只要这次没重新输入密码，磁盘上那个就被写成空字符串，下一次自动重连直接 `NEED_PASSWORD`。改成读 `peerStore.raw(id)`。
- **不勾「记住密码」时的两种越界**：以前是连接**之前**就把密码写成 `''`（连接失败也照清）；现在先在内存里留着，**只有连接成功**才清空磁盘上的那个——失败不该有副作用。

### 新增

- `test/peer-reconnect.mjs`（4 项断言）：不重输密码的重连保留旧密码；勾「记住」+ 新密码覆盖旧的；不勾且成功 → 磁盘上不剩密码；不勾且失败 → 磁盘上的旧密码原样不动。

## 1.0.30 — 2026-11-15

### 修复

- **对端发来坏 profile 会把本机那份覆盖掉**：`merge-profile` 以前解析失败就 `return`，然后照常 `rename` 落地——本机的 `profiles/<name>/package.json` 被换成一份坏 JSON，DSH 下次启动直接读不出来。现在解析失败或不是对象就整条跳过（计入 `skipped`、清掉临时文件、留一条 warn），本机文件一个字节都不动。
- **合并 profile 时 `private` 也被对端改掉**：只保留 `name` 是不够的——`private` 同属「这台机器自己的身份」，对端把 profile 打成可发布的，不该顺手把接收方也变成可发布。现在 `name` 与 `private` 都以本机为准，只采纳 `dependencies` 与 `dsh.profile.bundles`。
- **备份被轮转清掉时，回滚假装成功**：备份目录按 `backupKeep`（默认 5）轮转，老批次的备份可能已经没了；以前这种情况只是默默 warn 一句、`restored` 不计数也被当成正常结束，用户以为撤回了。现在结果里多一个 `missing`（`journal.rollback.missing` 同步记下），界面能如实说「这些文件的备份已经不在了」。
- **内存里的批次状态只进不出**：`Applier.syncs` 每同步一次就多一条，DSH 连开几天会挂着一长串。现在只留最近 20 条（`MAX_STATES`），更老的只存在磁盘上的 `<data>/syncs/` 里，`/local/syncs` 仍读得到。

### 新增

- `test/apply-guard.mjs`（4 项断言）：坏 JSON 的 `merge-profile` 不覆盖本机 profile 且不留 `.dshlink`；正常合并后 `name`/`private` 仍是本机的、依赖与 bundles 并集正确；连开 25 个批次后内存里只剩 20 条；对照组确认普通条目照样落地。
- `test/rollback.mjs` 加第 5 项：备份文件不存在时 `restored === 0`、`missing === 1`，内容保持原样，`journal.json` 里同样记下。

## 1.0.29 — 2026-11-15

### 修复

- **五处界面文案绕过了字典直接写中文**，英文界面里会嵌着中文：手机通道的「本机 192.168.x.x:port」提示、监听地址下拉的两个选项（`0.0.0.0 · 局域网可访问` / `127.0.0.1 · 仅本机`）、同步记录那一行「时间 · N 文件 · 大小」。全部改成 `t('…')`，新增 `connect.thisMachine`、`overview.bind`、`overview.bindLan`、`overview.bindLocal`、`sync.metaLine` 五个键。
- **英文品牌名还是旧的**：`nav`/`title` 写着 `Device Link`，`error.load` 与诊断导出标题里也是。这个包早改叫 `dsh-remote-connect` 了，英文用户会在设置页看到别人的名字。统一成 `Remote Connect`（中文仍是「远程互联」）。
- **「监听地址」这个字段标签本来就是英文 `Bind`**，中文界面里也照原样显示，现在也进字典。

### 新增

- `test/i18n-guard.mjs`（7 项断言）：中英键集合一致且不少于 150 条；每个键的占位符（`{n}` / `{size}` / `{time}`）在两种语言里相同；**字典之外的字符串里不许出现中文**（注释例外，用一个逐字符扫描区分字符串 / 注释 / 正则）；`t('…')` 用到的键都存在；界面文案里不再出现旧品牌名。可以传一个路径来验证守卫本身（拿故意写坏的样本跑过，确实会红）。

## 1.0.28 — 2026-11-15

### 修复

- **诊断里的「可用磁盘」看错了盘**：`/diagnostics` 的 `disk` 项探的是 `os.homedir()`，可同步写的是 `$DSH_HOME`——本机就是 C: 与 D: 两块盘。DSH 数据目录搬走以后，设置页会拿 C: 的余量去报告 D: 的状态，用户以为还有几十 GB，下一个大文件才失败。现在探 `dshHome()`，并在文案里写出是哪个路径，探测不到时也把路径带上。
- 磁盘探测抽成 `service.freeSpaceAt(dir)`：路径选择只有一处，测试也不必去碰真实磁盘。

### 新增

- `test/diagnostics.mjs`（7 项断言）：探测路径就是 DSH 数据目录（不是用户主目录）、结果里带路径、余量按人类可读单位、充足时 `ok`、不足 2 GB 降级 `warn`、探测不到时 `warn` 并说明位置、`env` 同时给出 `dshHome` 与版本。

### 工具

- 发布仓新增 `tools/pin-index.mjs`：一条命令钉版本 / 提交 / 时间戳，固定缩进 + LF 写回，顺手查 BOM、包名与 40 位 hex。以前用 `ConvertTo-Json` 既会写 CRLF，又会把索引摊成几十行假改动（1969B → 5108B）。

## 1.0.27 — 2026-11-15

### 修复

- **拉取方向的进度永远是 0 字节、没有当前文件**：`service.mjs` 的 `onProgress` 只从 `p.remote?.bytes` / `p.remote?.current` 取数，而这两个字段只有推送方向有——推送的字节数来自对端 `/progress`，拉取的进度则由本地 applier 平铺在顶层。于是「从对端拉」的任务在列表里从头到尾写着 0 字节，用户看不出是卡住了还是在动。现在两种形状都认（顶层优先、`remote.*` 兜底），`task.totalBytes` 在拉取方向也有值。

### 新增

- `test/sync-progress.mjs`（12 项断言）：推送方向从 `remote.*` 取到字节数 / 当前文件 / 总量；拉取方向从顶层字段取到同样三项；空事件不会把已经记下的数字清零，也不会改写状态。

## 1.0.26 — 2026-11-15

### 修复

- **`test/inventory-secrets.mjs` 在 Linux 上红（1.0.25 的 CI 只有 ubuntu · node 20 失败）**：那条断言写死「排除明细里要有 `skills/a/.env`」，可明细只留 40 条，而目录扫描顺序由文件系统决定——Linux 上那 50 个 `skills/many/dNN/.env` 先把名额占满了，`skills/a/.env` 排到了第 41 位以后。改成按**理由**查（存在 `reason === '凭据/密钥'` 的记录即可），断言与扫描顺序无关。产品代码没有改动。

## 1.0.25 — 2026-11-15

### 修复

- **「包含凭据」开关只对分类根目录下那几个直接文件生效**：`scanCategory` 里只有「根是文件」那条分支看了 `includeSecrets`，进目录以后的 `walk()` 一律套用 `excludedFile()`，于是 `.env`、`*.pem`、`id_rsa`、`cookies.txt` 这些**目录深处**的凭据即使勾了开关也照样被悄悄丢掉——界面上的勾选项等于半失效。现在 `includeSecrets` 进 `ctx`，两层判断都带上它。日志/临时文件与「超过单文件上限」不受这个开关影响（勾了凭据也不该把 2 GB 的 `.log` 拖过来）。
- **`prod.env`、`app.env` 这类以 `.env` 结尾的凭据没被算进凭据**：原来的正则要求文件名正好是 `.env`（或 `.env.xxx`），真实项目里 `prod.env`、`prod.env.local` 同样常见。改成「以 `.env` 结尾」都算。

### 新增

- `test/inventory-secrets.mjs`（7 项断言）：默认挡下目录深处的 `.env`/`.pem`/`cookies.txt`/`id_rsa`/`prod.env`；勾上之后它们进清单；日志与临时文件勾不勾都不走；勾上凭据也不绕过单文件上限；排除明细最多留 40 条而计数照实累加；勾上后排除数确实变少。
- `host/inventory.mjs` 里抽了 `noteExcluded(ctx, rel, reason)`：以前两条分支各写一份「记一条排除、最多 40 条」，其中一处还忘了封顶。

## 1.0.24 — 2026-11-15

### 修复

- **`test/deps.mjs` 会偶发失败（网络相关的误报）**：那条 repair 用例的依赖是 `file:`，但 `npm install` 仍会去注册表问 audit / fund / 元数据——在干净实装目录里第一次跑就失败过一次（同一目录再跑又过）。现在给这个测试钉上 `npm_config_offline=true`（顺带关掉 audit/fund/更新提示），测试彻底不依赖网络，别人装完第一次跑就是稳定的。产品代码没有改动。

## 1.0.23 — 2026-11-15

### 修复

- **请求体超过 100 KB 时那条请求永远不返回**：`readBody` 过去在超限时只 `req.destroy()`，`end` 事件不会再来，promise 永不 settle，连接一直挂着。现在改为停止累积、读完剩余数据后回 `413`（`BODY_TOO_LARGE`），并给了一个 100 KB 的明确上限。
- **请求体不是 JSON 时配对码接口回 500**：`/dsh-phone-api/paircode` 过去裸 `JSON.parse`，解不出就走 catch 报 500 并把 `Unexpected token` 甩给用户。现在统一用 `readJsonBody`，非法请求体回 `400`（`BAD_JSON`）。
- **`/phone/port` 与 `/phone/paircode` 这两条代理永远做不成事**：它们签的是 GET 且不带 body，于是 `switchPort(undefined)`、`setPairCode(undefined)` 必然失败——面板上看得到接口，实际换不了端口、改不了配对码。现在都是 `POST`，把请求体原样带下去；`/phone/start` 也改成透传 `{port, autoPort}`。
- **同进程直连的 `api.paircode(body)` 只能读不能改**：只有 HTTP 路由能改配对码，同进程调用永远是读取。现在读取与修改共用一份 `setPairCode()`，两条通路行为一致。
- **找 node.exe 时仍钉在 `~/.dsh`**：DSH 的数据目录已搬到 `DSH_HOME` 之后，这里只在 `%USERPROFILE%\.dsh` 下找，换了 DSH_HOME 的机器只能落到 PATH 里的 `node.exe`。现在顺序是 `DSH_HOME` → `~/.dsh` → Codex 自带 node → `node.exe`。
- 非 Windows 平台不再去 spawn 一个不存在的 `taskkill.exe`（直接返回 `false`；手机通道本来就只有 Windows 版）。
- 启动/换端口的状态码不再一律 504/400：端口被别的程序占着回 `409`，还在起回 `504`，参数不是合法端口才回 `400`。

### 新增

- `test/phone-http.mjs` 12 项断言：请求体（合法/空/数组/半截/**超限必须回话而不是挂住**）、启动与换端口的状态码映射、`DSH_HOME` 优先于 `~/.dsh`、末位回落到 `node.exe`、`killPid` 在非 Windows 不 spawn。

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
