# tools/voice — 让 DSH 发语音（轻量版）

只保留一条轻链路：**Edge TTS 在线合成**（默认音色 `zh-CN-XiaoxuanNeural` 晓萱），外加一个断网兜底
（Windows SAPI）。不加载任何本地模型，不占显存，CPU 占用可以忽略。

## 两条用法

### 1. 命令行（我用来给你发语音夹带）

```bash
node tools/voice/say.mjs --text "主人，我回来啦" --out voice-out/hello.mp3
echo "长文本" | node tools/voice/say.mjs
node tools/voice/say.mjs --engine sapi --text "离线兜底" --out voice-out/x.wav
node tools/voice/say.mjs --list-voices
```

| 参数 | 说明 |
|---|---|
| `--text` / `--file` / stdin | 要朗读的内容，三选一 |
| `--out` | 输出路径，默认 `voice-out/voice-<时间>.mp3` |
| `--voice` | Edge 音色，默认 `zh-CN-XiaoxuanNeural` |
| `--rate` / `--pitch` / `--volume` | 例如 `+10%` / `-5%`，默认 `default` |
| `--emotion` | 语气：`neutral` `happy` `excited` `gentle` `tsundere` `teasing` `sad` `tired` `angry`，写 `auto` 按措辞自动猜。**不写这个参数 = 行为与以前逐字节等价** |
| `--engine` | `edge`（默认，mp3）或 `sapi`（本机离线，wav） |

常用音色：晓萱（温柔，默认）、晓晓（清亮）、晓伊（活泼）、云希（年轻男声）、云扬（播报男声）。

## 语气：能做什么、做不到什么

实测结论先说：**Edge 免费端点会整条拒绝 `mstts:express-as`**。带风格标签的 SSML 一律回
`ERR closed early code=1007 reason=SSML is invalid`，而且合法风格名（`cheerful`）和乱写的
（`zzz-not-a-real-style`）报同一个错——是元素级拒绝，不是"不支持某几个风格"。所以微软原生
那套 20 多种情感风格，走免费端点拿不到。

能做的：**语速 / 音高 / 音量三件套**，按语气预先配好，听感上足够区分"开心"和"累"。参数表在
`emotion.mjs`，电脑端和手机端共用同一份，保证同一句话在两边听起来是同一个语气：

| 语气 | 语速 | 音高 | 音量 |
|---|---|---|---|
| happy 开心 | +12% | +8% | +5% |
| excited 兴奋 | +18% | +12% | +10% |
| gentle 温柔 | −12% | +4% | −6% |
| tsundere 傲娇 | +8% | +2% | +8% |
| teasing 调侃 | −3% | −5% | default |
| sad 低落 | −18% | −8% | −10% |
| tired 疲惫 | −20% | −12% | −8% |
| angry 生气 | +14% | +6% | +12% |

（表外还有 `RATE_SHIFT = −8%` 的全局语速偏移，是之前"手机端语速有点快"那条反馈加上的，
所有语气都叠这一层。）

实测：同一句话 `主人，今天的活儿我都干完了`，happy 3.24 s / excited 3.07 s / gentle 4.20 s /
tired 4.66 s / 不指定 3.38 s。

除了命令行，文本里也能写标签，`--text "[[开心]]太好啦[[/开心]]"`，句子里没写 `--emotion`
时会拿第一个标签当语气，标签本身不会被念出来。

### 手机那侧：23 档 + 强度 + 段间停顿

手机通道（`phone-bridge/`）用的是同一份 `emotion.mjs`，但把模型扩成了四个维度：

| 维度 | 作用 | 加法 |
|---|---|---|
| `rate/pitch/volume` | 语调本身 | 每档一套，见上表口径 |
| `intensity` | 同一档的强弱 | `开心:1.6` 这种写法，0.4–2.0，**非线性**（`eff = 1 + (it−1)×0.6`） |
| `gap` | 段间停顿（毫秒） | 前端在段与段之间补，累了停 300 ms、兴奋只停 50 ms |
| `segMax` | 一口气说多少字才断 | 累了 240 字就喘口气，兴奋能连到 460 字 |

档位从 9 扩到 23：neutral 平静 / happy 开心 / excited 兴奋 / playful 俏皮 / proud 得意 /
grateful 感谢 / gentle 温柔 / coaxing 撒娇 / shy 害羞 / tsundere 傲娇 / teasing 调侃 / sad 低落 /
wronged 委屈 / helpless 无奈 / tired 疲惫 / sleepy 困倦 / cold 冷淡 / angry 生气 /
surprised 惊讶 / worried 担心 / nervous 紧张 / curious 好奇 / serious 认真。

三条容易被静默搞错的边界，写在这里免得下次再踩：

- **`<break time="200ms"/>` 同样被拒**（code=1007，和 `express-as` 一模一样的报错）。停顿只能
  在 SSML 外面做，也就是上面那个 `gap`。
- **`'default'` 要当成 0% 算**。`RATE_SHIFT` 靠这个才能作用到 neutral 上；直接返回 `'default'`
  会让全局语速偏移对平静语气彻底失效，而且不报错。
- **强度必须有上限**：rate 夹在 [−30, 30]、pitch [−18, 20]、volume [−24, 24]。疲惫 ×1.5 不夹的话
  会到 −38%，念出来是坏掉的。

如果哪天要**真正的情感风格**而不是语速模拟，唯一的路是 Azure 语音服务（同一个引擎的付费端点，
F0 免费层每月 50 万字符），要一把 key。当前没有接。

### 2. 插件（界面里每条回复旁的朗读按钮）

`@memef1f1y/dsh-plugin-tts@0.6.7` 装在 desktop profile，走 `/dsh-tts-api/speak`。
设置 → 插件 → 语音，供应商选「Edge TTS」，音色选晓萱。

## 实现

- `edge-worker.cjs`：从插件 `lib/index.mjs` 里抽出来的零依赖 Edge TTS worker
  （Sec-MS-GEC v2 协议，`api.msedgeservices.com`）。契约：`node edge-worker.cjs -- <voice> <rate> <pitch> <volume>`，
  文本走 stdin，stdout 打印 `OK <tmp mp3 path>` + `SIZE <n>`。
- `say.mjs`：参数解析 + 调 worker / SAPI，产物落到 `voice-out/`。
- 已知小毛病：Edge 首次请求偶发 `websocket 1006` 或 `audio too small: 0`，重跑一次即可。

## 历史（已删除，不要再装回来）

为了"专属鲸鱼音色"，这台机器上先后装过两套重家伙，都因为吃性能被拆了：

1. **RVC 变声**（whale-voice 的三个 `.pth`）：Edge 出声 → 本机 GPU 变声。8.4 GB，常驻约 1.5 GB 显存。
   天花板明显——变声器换不掉发音习惯，怎么调都有"吞舌头"感（调参后 CER 已是 0.00，纯粹是音色问题）。
2. **IndexTTS2 真 TTS**：按参考音色重新合成，效果最像人。19 GB（权重 8.7 GB + venv），
   加载后吃 6.1–6.5 GB 显存，8 步扩散约 11–14 s/句。

两套都已从磁盘删除，`~/.dsh/tts-rvc/settings.json` 已清空，插件 `lib/index.mjs` 已还原成 npm 原版
（sha256 `bdec6ad6…`）。如果将来又想要鲸鱼音色，记住结论：**RVC 路线走不通，要上就直接上 IndexTTS2**。
