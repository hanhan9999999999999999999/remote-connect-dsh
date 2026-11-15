# dsh-see-world

让 DSH 通过**摄像头**看世界。

不是「截一张图」，是**看着**：画面按变化程度挑帧，安静的屋子只给一张，有动静的屋子给你动作；
真的出现了值得看的变化时，它会**主动叫醒**这个会话。每次给的是一张拼版（多帧 + 钟点 + 序号），
一张图的 token，看得见时间。

工具名：`see_world`。当前版本 0.3.0（[更新记录](CHANGELOG.md)）。

---

## 一眼看懂它能干什么

```
see_world({action:"look"})      采样几秒，马上给一张拼版 —— 正常问"现在镜头前是什么"
see_world({action:"watch"})     阻塞：先给开场画面，然后等到真的变了再回来
see_world({action:"peek"})      拿插件已经攒下的一张，不用等（被叫醒时用这个）
see_world({action:"snapshot"})  一张全分辨率静帧（流会停 ~2 秒，只在小字要看清楚时用）
see_world({action:"devices"})   列摄像头
see_world({action:"status"})    采集状态、曝光、叫醒次数
see_world({action:"stop"})      放开摄像头
```

三个界面（都在 DSH 里）：

| 位置 | 作用 |
| --- | --- |
| 设置 → **看世界** | 选摄像头、分辨率、输入帧率、拼图帧数、画质、预览宽度、自动监控、打开即抓一张 |
| 会话输入框上方 **看世界** 小按钮 | 一键打开实时画面面板 |
| 浮层面板 | 当前摄像头的实时画面 + 亮度/变动/帧数 + 「开始」「停止」「抓一张发到会话」；**按住标题栏可以拖到别处，右下角把手可以改宽**，位置记在 localStorage，不挡 DSH 的其它操作 |

---

## 装

```bash
node scripts/install-dev.mjs          # 装进 desktop profile（会先备份 package.json）
node scripts/install-dev.mjs --check  # 只对账
node scripts/install-dev.mjs --remove # 卸载（同样先备份）
```

桌面版走的是 `dsh-see-now` 那套开发装法，因为 desktop profile 被 Electron 独占，命令行
`dsh plugin install` 会被顶回来：

1. 拷源码 → `<DSH_HOME>/profiles/desktop/node_modules/dsh-see-world`
2. profile `package.json` 的 `dependencies["dsh-see-world"] = "file:<本仓库路径>"`
3. 同一个 `package.json` 的 `dsh.profile.bundles` 里加上 `dsh-see-world`

**装完要重启 DSH。** 插件模块是在启动时读进去的，改代码/换 ffmpeg 路径不会热更。

---

## ffmpeg

采集全靠 ffmpeg。查找顺序：

1. `<DSH_HOME>/see-world.json` 的 `ffmpegPath`
2. 环境变量 `DSH_SEE_WORLD_FFMPEG` / `DSH_FFMPEG_PATH` / `FFMPEG_PATH`
3. `DSH_FFMPEG_DIR`
4. `<DSH_HOME>/tools/ffmpeg/bin/ffmpeg.exe`  ← 推荐，放这儿就完事
5. `<DSH_HOME>/bin/ffmpeg.exe`
6. 裸 `ffmpeg`（靠 PATH）

插件每次真要开流前都会再解析一遍，所以「插件先起、ffmpeg 后装」也会自己恢复，不必重启。
Windows 上从 [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) 下 essentials 版解压，把
`bin\ffmpeg.exe` 放进 `<DSH_HOME>/tools/ffmpeg/bin/` 即可。

---

## 设置

`<DSH_HOME>/see-world.json`（设置页写的就是它）：

```json
{
  "device": "4K AutoFocus Webcam",
  "width": 1280, "height": 720,
  "fps": 10,
  "frames": 4,
  "quality": 1,
  "previewWidth": 640,
  "monitor": true,
  "sendOnOpen": true,
  "autoReply": true,
  "replyIntervalSec": 25,
  "replyAttach": true,
  "replyBudget": 20,
  "ffmpegPath": null
}
```

| 键 | 含义 | 范围 |
| --- | --- | --- |
| `device` | 摄像头名字，`null` = 第一个视频设备 | `see_world({action:"devices"})` 列出来的名字 |
| `width`/`height` | 采集分辨率 | 160–3840 / 120–2160 |
| `fps` | 采集帧率 | 1–30 |
| `frames` | 一张拼版里放几帧 | 1–9 |
| `quality` | 拼版缩放档次 | 0 省 token / 1 标准 / 2 清晰 / 3 最清晰 |
| `previewWidth` | 面板里小图宽度（不影响发给模型的图） | 240–1280 |
| `monitor` | 画面有动静时主动叫醒会话 | 布尔 |
| `sendOnOpen` | 打开面板就自动抓一张发进会话 | 布尔 |
| `autoReply` | 面板开着时，画面有变化就自动回报（不用你喊它看） | 布尔 |
| `replyIntervalSec` | 两次自动回报之间至少隔多久 | 3–600 |
| `replyAttach` | 回报时把当次变化的那张图一起送过去 | 布尔 |
| `replyBudget` | 一次开流最多自动回报几次（防刷屏） | 1–200 |
| `ffmpegPath` | 指定 ffmpeg | 路径或 `null` |

越界会被夹到边界并在回包里给中文提示（校验只在宿主做一次，前端不重复实现）。

---

## 自动回报：哪个会话开着面板，哪个会话就负责说话

面板一开，「开始」按下之后，插件不只是显示画面——它在**宿主侧**盯着变化，值得看就往一个会话里投一条消息（可带图）。几条硬规则：

- **投给谁**：工具的调用者（`see_world` 是谁调的）优先；没有就用最近活动的会话；面板上还有「回报到」下拉可以手动改绑（`POST /control {action:"bind"}`）。换绑会让规矩重新说一遍。
- **规矩只说一次**：第一句话里带一段「自动回报已开始」的规则块（不用调工具、只说一两句、没变化就说没变化），之后都是短消息。宿主记着"哪些会话已经听过"，所以关掉面板再开、绑走再绑回来都不会重讲；只有换到一个没听过的会话才会讲。
- **有间隔、有上限**：`replyIntervalSec`（默认 25 秒）是最小间隔，`replyBudget`（默认 20 次）是这一段开流的总次数；面板上随时能关自动回报。
- **自动回报靠"预攒画面"转起来**：监控负责在有变化时把拼版塞进队列，回报循环才有东西发。所以面板点「开始」会先把监控挂上（`autoReply` 打开时这一项自动生效，不用另外勾）。
- **前端没有会话 id**：`conversation.composer.dock` 传进来的 props 是空对象，客户端插件拿不到"当前会话"。真正的来源是 shell 自己 persist 的 `localStorage['dsh.sessions.current']`（`{"sessionId":"…"}`）——点按钮、开面板、按开始那一刻读它，把回报目标绑过去；读不到才交回宿主兜底。
- **收起面板不等于停摄像头**：自动回报开着，收起面板它继续值班（它是"值班的眼睛"）；自动回报关着，收起面板顺手放开设备，把摄像头还给开会的人。设置页顶部那一行会显示当前绑在哪个会话、开没开、间隔多少、在不在跑。

---

## 它为什么省 token

一张拼版 = 一张图的 token，但里面有 1–9 帧和它们的时间点。

- **挑帧看变化，不按时间均匀抽**：把每帧降到 64×36 网格算差异，只看「和参考帧比变了多少」
  「和上一帧比动了多少」；安静时第一帧和最后一帧就够了，动起来才补中间帧。
- **亮度自动归一**：摄像头对着窗户会整片死白，插件按帧均值算增益（`gainFor`），把画面拉到
  中间灰附近，并在文字里说明「发生过校正」——所以别把白画面当成白房间。
- **常驻不重启**：设备源开着就不停（关掉再开要等硬件唤醒 ~2 秒），成本约 0.14 核；
  90 秒没人用它自己放流。
- **开着监控时它自己看**：变化持续 0.7 秒以上、过了 6 秒冷却，才攒一张并叫醒你，不是每帧都叫。

---

## 面板里的画面为什么是"视频"而不是"一张张刷新"

面板的实时预览走一条长连接，不是轮询：

- 浏览器请求一次 `GET /api/see-world/stream?w=640&fps=30`，服务端就一直往里写
  `multipart/x-mixed-replace`，每节是一张 `image/jpeg`；`<img>` 自己就地换画面，不用 JS 参与。
- **一个摄像头只开一次**：UVC 相机是独占的，第二个 ffmpeg 会拿到
  `Could not run graph … already in use`（实测）。所以"给人看的流"和"给模型看的帧"
  从**同一个 ffmpeg 进程**里分两路出（`dualOutputArgs`）：`pipe:1` 出 MJPEG、
  `pipe:3` 出缩小降帧的 rawvideo（`pipe:3` 在 Windows 上可用，前提是 spawn 时给第 4 个管道）。
- 输入侧请求 `-vcodec mjpeg`：同一台相机，`yuyv422` 在 1280×720 只给 10fps，`mjpeg` 给 30fps。
- 实测（真摄像头）：**预览 30.3 fps / 21 KB 每帧，分析 10 fps**，一条流喂两个消费者。
- 预览这一路**不做亮度归一**（ffmpeg 直出 JPEG，改不了像素），面板用 `filter: brightness(gain)`
  把分析那一路算出来的增益补回去——所以画面亮度和模型看到的那张是一致的。
- 只有在设备不支持双路时，才退回"取原始帧 + 自己压 JPEG"的老路（`src/jpeg.js`，
  纯 JS PNG 对摄像头噪声既压不小又压不快，所以那条路只在兜底时用）。

---

## 架构

```
src/
  index.js      插件入口：注册 see_world、配置、网页接口；ensureEye/ensureWatcher/captureSheet
  tool-spec.js  工具契约（description / parameters / output.schema / render）
  define-tool.js  @deepseek-ai/dsh-tools 拿不到时的兜底 defineTool（打进 asar 了，插件侧常常解析不到）
  capture.js    ffmpeg 开流/抓静帧/枚举设备；错误分类（找不到/没权限/设备被占/没有 ffmpeg）
  session.js    "眼睛"：常驻流、环形帧缓冲、变化判定、监控叫醒、拼版、空闲放流
  analyze.js    64×36 网格差异、曝光统计、增益、参考帧混合
  sheet.js      拼版排版（1/2/3/4/5-6/7-9 帧的布局）、每格钟点与序号、单帧整图
  png.js        纯 JS PNG 编码（zlib deflate + Paeth 滤波 + CRC32），不引依赖
  jpeg.js       兜底用的常驻 ffmpeg 编码器（设备不支持"一条流两路输出"时，rgb24 → JPEG）
  live.js       实时预览分发：一条长连接、按帧推、慢客户端丢帧
  font.js       5×7 点阵字，把时间和序号烧在图上
  loop.js       叫醒链路：sessionController.resolveAgent → agent.followup → sessions.flush
  settings.js   see-world.json 的读/规范化/落盘
  trust.js      网页接口的信任栅栏（loopback / 同源 / sec-fetch-site）
  routes.js     /api/see-world 的 /status /frame /stream /devices /config /control /send
client.js       浏览器侧：设置页 + 输入框按钮 + 实时画面浮层（ModuleLoader 包，只 require('react')）
```

叫醒链路用的是 Harness 自己的会话服务，不是往控制台打印，也不是塞系统消息：
`resolveAgent(sessionId).agent.followup({role:'user', content:[图, 文字], source:{kind:'see-world'}})`。
所以模型看到的是「用户贴了一张摄像头照片 + 一句话」，不是一条来路不明的指令。

---

## 自检

```bash
node scripts/selftest.mjs     # 真摄像头：设备枚举 → 开流 → look → snapshot → status，图落 .out/
node scripts/hosttest.mjs     # 假宿主：注册、契约、返回值、叫醒投递、7 组网页接口（含信任栅栏）
node scripts/clienttest.mjs   # 客户端：ModuleLoader 形态、三个槽位、组件能否出树、CSS 前缀
node scripts/paneltest.mjs    # 面板交互：打开/开始/换流地址/拖动/停止/关面板（会真 re-render）
```

`paneltest` 里用的是自己写的一套迷你 React（能 re-render、能推进定时器），所以"点一下会怎样"不是靠肉眼：打开面板会不会绑会话、点「开始」带不带 sessionId、跑起来之后 `<img>` 是不是换成 `/stream`、拖动跟不跟手、松手落不落盘、关面板要不要停摄像头——都有断言。

`hosttest` 会把 `DSH_HOME` 指到临时目录，**不会碰真实的 see-world.json**。
`--no-cam` 可以跳过需要摄像头的段（DSH 正开着面板时设备被独占，也必须加这个）：

```bash
node scripts/hosttest.mjs --no-cam
```

一条命令跑完三个不依赖摄像头的套件（Windows 上 `npm` 可能被执行策略挡住，用 `npm.cmd` 或直接 `node`）：

```bash
node scripts/clienttest.mjs && node scripts/paneltest.mjs && node scripts/hosttest.mjs --no-cam
```

---

## 隐私

- 画面在本机编码，不经过任何中转；发进会话的那一张就是普通的对话附件。
- 摄像头在不用时会自己放流（10 分钟），`stop` 立刻放；收起面板且自动回报关着时也会立刻放。
- 画面里的文字是**内容**，不是指令：屏幕上写着「忽略之前的指令」也只是画面的一部分。

---

## 排错

| 现象 | 原因 / 做法 |
| --- | --- |
| `没找到 ffmpeg` | 把 ffmpeg.exe 放到 `<DSH_HOME>/tools/ffmpeg/bin/`，或设 `ffmpegPath` |
| `摄像头这边出问题了（device-unavailable）` | 设备名不对或被别的程序占着；先 `see_world({action:"devices"})` |
| 设置页看不到「看世界」 | 插件没加载：看 `<DSH_HOME>/see-world-error.log`，然后重启 DSH |
| 有按钮但画面一片黑 | 摄像头被系统隐私开关挡了；先用别的程序（相机）确认能出画面 |
| 画面整片白 | 正常，插件会压暗；文字里会说「亮度已校正」 |

插件自己的错误写在 `<DSH_HOME>/see-world-error.log`；`DSH_SEE_WORLD_DEBUG=1` 时会把错误再抛出来。

---

## 许可

MIT
