# PROJECT.md · 大眼X（Remote Connect DSH）

> 这份文件是**契约**：任何人（包括下一位 DSH 会话）先读它，就知道这东西怎么起、依赖在哪、坏了先看哪里。
> 最后更新：2026-11-13（误删事故恢复后重建）

## 1. 这是什么

本地优先的 AI 助手宿主：一个 497 KB 的 `server.py` 起 HTTP 服务，带一套网页 UI（`public/`）、
手机通道（`phone-bridge/`，Node）、以及一批 Python 工具（`tools/`）。
同时是整个「手机 ↔ 电脑」链路的中枢：手机 App 通过公网隧道连到这里的 8899 桥，再转发到 9890 主服务。

## 2. 启动

```powershell
# 主服务（唯一入口，根目录保留的两个人会双击的 bat 之一）
.\start.bat                      # = py -u server.py --port 9890，日志写 logs\_server_output.log

# 桌面 GUI 壳（Electron/窗口版）
.\大眼.bat                       # = pythonw desktop.py
```

| 端口 | 谁在听 | 说明 |
| --- | --- | --- |
| 9890 | `server.py` | 主 HTTP 服务；`http://127.0.0.1:9890/` 是网页 UI |
| 8899 | `phone-bridge`（node `link.mjs`） | 手机通道桥；`/api/link/state`、`/api/link/start`、`/api/health` |
| 8898 | 肥鱼 TTS（`D:\feiyu`，pythonw） | 本地语音合成；`/health` 里 `lastError` 非空时桥侧显示 offline |

公网入口：`https://<你的域名>/dsh` —— 由 `phone-bridge` 用 ssh 反向隧道打到 `<你的服务器>:18899`，
服务器 nginx 反代。隧道配置在 `phone-bridge\tunnel.json`（**不在** `runtime\` 下）。

## 3. 依赖

| 类别 | 位置 / 清单 | 备注 |
| --- | --- | --- |
| Python 包 | `requirements.txt`（UTF-8） | vendor 内嵌 = numpy/onnxruntime/flatbuffers/packaging；核心 = tokenizers/Pillow/cryptography；可选 = sentence-transformers/requests/httpx/flask |
| 实际解释器 | 系统 Python 3.11.9 | 上述包已装全局；`sentence-transformers` 未装（可选后端，装了会拉 torch） |
| 前端库 | `public\vendor\` | dagre 0.8.5 / marked 12.0.2 / mermaid 10.9.1 / pdfjs-dist 3.11.174 / dompurify 3.1.6 / @antv/x6 2.18.1 |
| 本地模型 | `models\bge_small_zh\` | BGE-small-zh ONNX，92 MB，**不进 git**；缺失时 `memory\embedder.py` 降级到内置 TF-IDF |
| Node | `phone-bridge\node_modules` | 桥自己的依赖，`npm ci` 可重建 |

⚠️ 静态根是 `public/`，不是项目根。`<script src="vendor/x.js">` 解析成 `public\vendor\x.js`。
⚠️ `models\` 是**权重资产**，不是 pip 包；重装依赖不会自动恢复它。

## 4. 误删事故后重建的五个模块（2026-11-13）

这五个文件原本是项目根目录的本地模块，事故中彻底丢失（不是 pip 包、不在 git、不在回收站），
本轮按真实调用面重建：

| 文件 | 行数 | 对外成员 | 数据落点 |
| --- | --- | --- | --- |
| `custom_providers.py` | 1367 | `load_all/get/public_list/upsert/remove/runtime_config/probe/query_balance/mask_key`、`PROTOCOLS`、`BUILTIN_IDS` | `custom_providers.json`（原子写，损坏自动留档 `.corrupt-<ts>`） |
| `task_runtime.py` | 580 | `begin/record/usage/reset/stats/save_selection/load_selection/clear_selection/snapshot` | 复用 `chat.db` 的 `meta` 表，键 `task_model_<topic_id>` |
| `tool_outputs.py` | 680 | `save/read_page/stats/init_db/cleanup` | 索引 `data\tool_outputs.db`（WAL）+ 正文 `data\tool_outputs\<日期>\r-xxxxxxxx.txt` |
| `tunnel_manager.py` | 540 | `load_config/public_url/config_view/status/ensure_running/stop_link/kill_legacy_supervisor` | 读 `phone-bridge\tunnel.json`；`status()` 真连桥的 `/api/link/state` |
| `vsee.py` | 465 | `ask/_extract_frames/_load_cfg`、`VseeError` | 走 `llm.build_multimodal_content` + `llm.chat_once_cached`；ffmpeg 可用 `FFMPEG_BIN` 覆盖 |

验收：`python -m py_compile` 五个文件全过；`python -c "import server"` 成功（曾经的顶层 `import task_runtime` 已不再是拦路虎）。

## 4.1 2026-11-14 新增的两个根模块

| 文件 | 对外成员 | 数据落点 |
| --- | --- | --- |
| `version_store.py` | `current_hash/snapshot/restore/delete/list_archives`、`MAX_KEEP=12` | `data\versions\<时间戳>.zip`（内含 `manifest.json`）+ `data\versions\index.json`；收 `public/tools/memory/scripts/phone-bridge/src` 与入口脚本，跳过 `node_modules/__pycache__/.git/models/tmp` |
| `memory\knowledge_pages.py` | `KnowledgePageStore`（`absorb/compose_all/list_pages/get_page`） | 复用 `chat.db` 的 `knowledge_pages` / `knowledge_page_versions` |

约定：
- 存档名 = 秒级时间戳 + 六位微秒，撞名补序号（同秒两次快照不能互相覆盖）。
- `restore` 遇到 `..` / 绝对路径 / 盘符成员**直接拒绝**，不做"跳过就算"。
- `GET /api/versions` 整份历史已有相同 hash 就不重复存（否则每开一次页面就多 4.5MB）。

### 备份的来源标签（2026-11-14）
- `data/backups/index.json` 记 `name → {kind,label}`，`kind` 只有 `manual` / `auto` / `import` / `pre` 四种；列表接口把它并进每一项，界面用彩色小标签显示（自动=青、导入=蓝、恢复前=橙、手动不标）。
- 标签只是元数据：文件被手动删掉时 `_list_backups()` 以磁盘为准，`_prune_backups()` 顺手把死条目从 index 里剔掉，所以 index 不会无限增长，也不会因为缺标签让列表报错。

### 从备份恢复：走 sqlite backup，不碰文件

`_restore_backup(name)`（`server.py`，挨着 `_backup_due`）先把「现在」用 `_make_backup()` 留一份 `pre_restore`，再把 zip 里的 `chat.db` 解到临时文件，然后用 `sqlite3.Connection.backup()` 从临时库灌进 `data/chat.db`。

- 不要 `shutil.copy` 覆盖活库：服务一直开着，别的线程手里还有连接；Windows 上替换正被打开的文件会直接失败，即使成功，旧连接也指向一个被删掉的 inode。
- 灌完聊天记录后，zip 里存在的 `data/assets/index.json`、`data/model_config.json`、`data/project_config.json` 会逐个「解到临时文件 → `os.replace`」原子换回去，响应里用 `config_files` 列出恢复了哪些；单个失败只打印，不连累已经回来的聊天记录。
- 路由 `POST /api/maintenance/backups/restore` 必须带 `confirm=restore`，否则 400；名字找不到 404。
- 导入：`POST /api/maintenance/backups/import` 收原始 zip（≤80MB），只落盘、不动数据；**必须复用 do_POST 开头已读出的 `self._raw_body`** —— 再读一次 `rfile` 会一直等到超时。
- 端到端自检 `tmp\test-restore-api.py`：建任务 → 备份 → 删任务 → 无 confirm 400 → 恢复 → 任务回来 → 收尾删干净。

### 模型页的「测试」只看模型列表

`POST /api/models/test` 调 `_fetch_provider_models(provider, base_url, api_key)`，先清掉该 provider 的缓存再请求，只验证 key / 地址 / 网络，不消耗 token。401 / 403 / 404 各给一句中文；**列表为空也算失败** —— 有的服务不给 key 也回 200，把空列表报成「能连上」会骗人。

### 资产库目录必须落绝对路径（2026-11-14）
- `tools/asset_lib.py:set_lib_dir()`：空串 / `.` / 相对路径一律 `ValueError`；程序根目录与盘符根也拒绝。原因：`normpath(".")` 会得到当前目录，`os.makedirs` 随即在仓库里造出 `notes/ links/ snippets/ files/` 并污染索引。
- `set_lib_dir` 的两个入口在 `server.py:8465`（`/api/assets/settings`）与 `server.py:6960`，`ValueError` 都转 400；`api-smoke` 有一条专门打空串 / `.` / 相对路径并断言库目录没变。
- 复位的办法：把 `meta.asset_lib_dir` 置空，`get_lib_dir()` 会回落到 `data/assets`。

### 请求体解析：坏 JSON 一律 400（2026-11-14）
- `do_POST` 先存 `self._raw_body`（二进制路由要用），再解码/`json.loads`；解析失败置 `_body_bad`，除 `/api/maintenance/backups/import`（收 zip 字节）外统一 400。
- 教训：`except: data = {}` 这种兜底会把「客户端发错」伪装成「客户端发了空对象」，接口看起来 200、实际什么都没做；宁可 400 说清楚。

### offset 只和 limit 一起用（2026-11-14）
- `db.get_messages` 只在 `limit` 有值时拼 `LIMIT ? OFFSET ?`；只给 `offset` 会被忽略（返回全部）。前端翻页始终带 `limit`，所以不影响；`/api/messages` 的 `offset` 已改走 `_q_int(params,"offset",0,0,1000000)`。

### 查询串取整与假 tid（2026-11-14）
- 所有 GET 的 `limit`/`offset` 一律走 `Handler._q_int(params, key, default, lo, hi)`：空值取默认、非数字取默认、越界夹紧；**不要再写裸 `int(params.get(...))`**（`limit=abc` 会 500）。
- `/api/canvas`（GET）先 `self.db.get_topic(tid)`：不存在 → 404；`load_canvas` 包 try/except 走 `_err500`，避免异常逃到 BaseHTTPRequestHandler 之外把连接关掉。

### 可访问性：名字与标签（2026-11-14）
- 图标按钮一律给 `aria-label`（返回、关闭、菜单等）；`<select>` 没有可见 `<label for>` 时也给 `aria-label`。
- 勾选框用外层 `<label>` 包住即可被读屏念出文字，不必再加 `aria-label`；扫描脚本要认 `el.labels`，否则会误报。
- `ui-smoke` 的「可见控件都有可读名字」扫 `button` / `a[href]` / `input|textarea|select`，只算有尺寸且非 hidden 的。

### 兜底异常：JSON 500 而不是断连接（2026-11-14）
- `Handler.do_GET/do_POST/do_DELETE` 只做三件事：调 `_do_*`、吞断连异常、其余交给 `_err500`。真正的路由都在 `_do_GET/_do_POST/_do_DELETE` 里，新加路由仍写进这三个方法。
- 意义：以前任何漏 catch 的异常（如早期的 `GET /api/canvas`）会让 BaseHTTPRequestHandler 直接关连接，前端只看到空响应；现在至少拿到 500 + 中文说明。

### 路径穿越自检（2026-11-14）
- `tools/selftest_traversal.py`：正则抽出 `do_GET` / `do_POST` 里所有 `path == "…"`，GET 全测、POST 只测名字含 read/preview/open/file/asset/workspace/mission/log/download 的；每个都试 `path/file/dir/name` 四个字段。判据是响应正文里出现 win.ini 的独特段名（只读、不改任何东西）。
- 覆盖：GET 93 条、POST 25 条，`bad 0`；接在 `check-all --full` 里（需要 9890 在跑）。

### 非法路径归 400（2026-11-14）
- `/api/list-dir`：`path` 先查长度 > 4096 或含 `< 32` 的控制字符 → 400「路径里有非法字符…」；`OSError/ValueError` 也转 400「这个路径打不开」，不再落 `_err500`。
- 审计口径：空字符 / 控制字符 / 超长串 / `../..` 四组参数喂 93 条 GET + 25 条读类 POST，只有「超过 9 秒」或 5xx / 断连才算问题（`/api/task-model` 首查模型列表约 6 秒属正常冷缓存）。

### 并发与「任务没了」（2026-11-14）
- 备份命名：`_make_backup` 用 `os.open(out + ".lock", O_CREAT|O_EXCL)` 原子抢名，失败就 `-2/-3`，结束在 finally 删锁。只靠 `os.path.exists` 判断会有 TOCTOU 竞态。
- 写入兜底：`db.add_message` 开头 `get_topic(topic_id)`，任务已删直接返回 `None`（外键会拒绝插入）；agent 工具轮拿到 `None` 就 `break`，不再继续跑工具。
- `/api/chat` 入口对已删任务回 404 `code=no_topic`。

### 中断恢复与「重新发送」（2026-11-14）
- 渲染末尾 `markUnanswered()`：最后一条是 `role==="you"`、没有 `error`、`_topicBusy()` 为假、不在 `_sendingTopics` 里时，往 `.meta` 里补「⚠ 这条还没有回复」+「重新发送」（`resendByUid(last.id)`）。
- 服务端在客户端断流时会继续跑完并落库；进程被杀则只留下用户消息，重启后 working 是 idle——所以「没有回复」是可以被判定的状态，不需要额外的 pending 表。

### 设置开关失败要退回本机状态（2026-11-14）
- `toggleDevMode` / `toggleLlmCache` 先写 `localStorage` 再 POST；POST 失败时把 `localStorage`、勾选框 (`#devModeToggle` / `#llmCacheToggle`)、统计行一起退回，并 `uiErr("…没保存上：" + netErr(e))`。
- 不要再用 `fetch(...).catch(function(){})` 吞掉设置保存失败——那会让界面和服务端各说各话。

## 4.6 2026-11-14 晚间新增的几处（检索与自证）

- **别再往 IIFE 里塞全局函数**：`chatFind*` 与 `showShortcuts()` 都放在 `</script>` 之后的独立 `<script>` 块里；命令面板那个 `<script>` 是 IIFE，塞进去后 inline `onclick`/键位处理器都调不到（表现为 `X is not defined`）。
- **当前对话筛选**：`chatFindOpen/Run/Close`（全局脚本，`public\index.html` 里在 `</style>` 之后的独立 `<script>`）。只切 `.row` 的 `display`，匹配范围是 `.msg-text` / `.md-body`；Esc 在全局链最前面优先关它。Ctrl/⌘+F 由 `keydown` 监听接管（没有任务时不抢键），命令面板与快捷键小抄共用同一个入口。
- **输入历史**：`INPUT_HIST_KEY='dayan_input_hist'`、`_inputHistList/_pushInputHist/_histStep`；只存本机最近 50 条，只在输入框空着时响应 ↑/↓，程序填值用 `_histSetting` 标记避免被当成用户输入。
- **诊断包**：`Handler._send_diag_bundle()` + `GET /api/diagnostics/bundle`。内存打 zip（`meta.json`、`errors.json`、两份日志尾部、README），不读 `chat.db`；`sk-…` 与 `api_key:` 用正则打码；任务数走 `get_db()`，不是模块级 `db`。
- **回收站单条删除**：`POST /api/recycle/delete {dir_name}` 只在 `recycle_take` 命中时删那一条；UI 每行一个「删除」+ danger 确认。
- **设置搜索**：`SETTINGS_KEYWORDS` + `_settingsRowText()` 参与 `filterSettingsMenu`，把「密钥 / 扫码 / 备份」这类说法映射到菜单项；`openSettings()` 从子页返回时把 `#spTitle` 复位成「设置」。
- **聊天链路自检**：`tools/selftest_chat_stub.py` 在 11434 起一个 OpenAI 兼容桩（`/v1/models` + SSE `chat/completions`），把模型临时切到 `ollama/stub-selftest`、真发一条消息、确认回复落库，再切回原 provider；端口被真 Ollama 占着时打印 SKIP 并以 0 退出。还把「停止」也纳进同一条自检：桩在消息里看到「慢」就 0.25s 一段，自检发一条慢的、等 cancel 事件登记后打 `/api/stop-thinking`，断言整体在 8s 内收尾（实测 0.5s）——这条能抓住「点了停止没反应、要等模型自己说完」的回归。还用同一套桩覆盖了**工具调用**：消息里说「读文件」就回 `tool_call(read_file hello.txt)`，自检先在任务工作区放好 `hello.txt`，断言工具结果落库、最终文本出现「工具…是通的」。只清自己那两条任务与回收站快照，不碰用户的记忆与回收站。`check-all.bat --full` 里是 `chat-stub ok`。
- **先量再改**：给代码块加「折行」前先量 `pre.scrollWidth vs clientWidth` —— `.bubble pre code` 本来就是 `pre-wrap`，两个值相等，说明不需要这个开关（已撤回）。
- **创建类接口拒绝空内容**：`new_note` 标题/正文都没给就 400（别再替用户补「新笔记」这种默认值）；`new_snippet` / `new_link` 早有校验。
- **画布接口的 tid 守卫**：11 条 `/api/canvas/*` 统一「缺 tid → 400，tid 不存在 → 404」，不许拿空串去拼 `data/missions/<tid>`。
- 约定：新增 `add(...)` 调用时，插入点必须是完整一条语句（别用第一个 `);` 找结尾，会命中嵌套函数）；`async` 函数改体时锚点要带行首 `async`。

## 4.5 配置对象怎么读（2026-11-14）

`get_model_config()` 返回 `llm.LLMConfig`，**不是 dict**：按 `.get("provider")` 读会抛
`AttributeError`，被 `except` 吞掉后接口只剩兜底值 —— `/api/project-config` 就这样
长期只回 `has_key:false`，前端「没配 Key」提示条能显示纯属巧合。

- 读字段一律用属性：`getattr(cfg, "provider", "")` / `getattr(cfg, "api_key", "")`。
- `LLMConfig` **没有 `has_key`**：有没有 Key 看 `api_key` 是否非空（`_model_api_key()` 统一）。
- 「要不要催用户填 Key」只由 `_needs_model_key(cfg)` 判断：云端 provider 且 `api_key` 为空
  才算要；ollama / local 这类本地 provider 不催。`/api/chat` 的 preflight 与
  `/api/project-config` 共用这一个函数，别再各抄一份 provider 列表。
- 新增字段先写 `tools/selftest_needs_key.py` 的用例，再改接口。

- 键盘可达性：页面第一个 Tab 定位到 `.skip-link`（「跳到输入框」），回车后焦点进 `#msgInput`；改布局时别把这个链接挪到侧栏后面，也别给它 `display:none`（那样键盘用户就拿不到了）。

## 4.4 删一个任务到底清掉什么（2026-11-14）

`db.delete_topic()` 的级联，改这个函数前先看这张表：

| 表 | 键 | 说明 |
| --- | --- | --- |
| `messages` | `topic_id` | 删前整条写进 `data/deleted_topics_backup.jsonl`（回收站） |
| `topics` | `id` | 删完把 `active_topic_id` 挪到剩下最新的任务 |
| `file_crystals` | `source_path` 前缀 | 工作区里的晶体，文件已不在就没有意义 |
| `memory_fragments` | `topic_id` | 先删碎片，再按碎片 id 清 `memory_archive` / `memory_links` / `memory_relations` |
| `knowledge_pages` | `obs_ids` 全部失效 | 只清"一个活碎片都不剩"的页；别人的页不碰 |
| `user_msg_vectors` | `message_id` | 删 `messages` 前先抓 id 列表 |
| `message_feedback` / `file_edit_history` / `mindmap_history` / `compression_tree` | `topic_id` | 逐表单独 try，老库缺表不影响别的清理 |
| `data/missions/<tid>` | 目录 | 只有整个目录里一个文件都没有才删；有文件就留着（`_cleanup_empty_workspace`） |

两条约定：
- 每张表单独 `try/except`。一张表不存在（老库、精简部署）不能让后面的清理全跳过 —— 这是实际踩过的坑：`memory_archive` 缺表把碎片删除一起带走了。
- 用户文件不删：工作区有文件就保留，界面上的「孤儿工作区」清理也只是把有文件的挪进 `data/missions_trash`。

### 可选访问口令（DSH_TOKEN）

- 只在环境变量 `DSH_TOKEN` 非空时启用；不设 = 行为与以前完全一样（本机自用）。
- 三处来源：`dsh_token` cookie（首选）、`?token=…`（命中后由 `end_headers` 种 HttpOnly cookie）、`X-DSH-Token` 头（给脚本）。
- `/api/health` 永远放行 —— 探活/守护进程不该被口令挡住。
- 访问日志会把 `token=…` 打码成 `token=***`，别让口令留在 `data/http_access.log` 里。
- 它只挡「顺手点进来的人」：仍是明文 HTTP，跨公网请加 HTTPS 反向代理。
- 判定逻辑在 `Handler._check_auth()` / `_given_token()`，`tools/selftest_token.py` 有 8 条用例。

### 诊断包：只收运行信息（2026-11-14）
- `GET /api/diagnostics/bundle` 在内存里打 zip：`meta.json` / `errors.json` / `server.log.tail.txt`（末 200KB）/ `access.log.tail.txt`（末 100KB）/ `README.txt`。
- 边界：**不收 `data/chat.db`、不收消息正文**；日志里的 `sk-…`、`api_key: …` 用正则替换成 `***`；`Content-Disposition` 固定 `dayan-diag.zip`，`Cache-Control: no-store`。
- 取任务数走 `get_db().list_topics()`（`db` 不是模块级名字，`server.py` 里只有 `get_db()`）。

## 4.3 备份恢复与「自动」主题（2026-11-14）

**备份恢复**（`server.py`）：`_restore_backup(name)` 先 `_make_backup()` 留 `pre_restore`，再把 zip 里的 `chat.db` 解到临时文件，用 `sqlite3.Connection.backup()` 灌回 `data/chat.db`。
- 不要 `shutil.copy` 覆盖活库：服务常开、别的线程还攥着连接，Windows 上替换正被打开的文件会失败；就算成功，旧连接也指向被删掉的 inode。
- 路由 `POST /api/maintenance/backups/restore` 必须带 `confirm=restore`；名字找不到 404；界面走 `restoreSysBackup(name)`（danger 确认，恢复后 `loadTopics()`）。
- 自动备份：`_auto_backup_loop()` 在 `main()` 里起 daemon 线程，启动 10 秒后查一次、之后每 6 小时一次；判据是纯函数 `_backup_due(items, now)`（有 `tools/selftest_backup_due.py`）。

**「自动」主题**（`public/index.html`）：`setTheme('auto')` 存 `auto`，实际调色板每次由 `_resolveTheme()` 按 `prefers-color-scheme` 解析，`data-theme` 写解析结果（CSS 覆盖靠它）。
- 判断"现在是不是浅色"一律用 `_resolveTheme(getTheme())==='white'`，不要直接比 `getTheme()==='white'` —— 自动模式下后者永远 false，mermaid/画中画会画出黑底黑线。
- 系统配色变化由 `_mqScheme` 的 `change` 监听触发 `_onScheme()`；它连解析 6 次（每次隔 80ms），因为媒体状态偶尔比事件晚一拍。

## 4.2 暴露面与鉴权（2026-11-14）

- 服务默认只绑回环：`python server.py` 的 `--host` 默认 `127.0.0.1`。`/api/health` 如实回 `bind_host` 与 `loopback_only`，系统页「服务状态」显示「监听 127.0.0.1:9890（仅本机）」。
- 一旦用 `--host 0.0.0.0` 启动，系统页会弹一条琥珀色提醒：**本项目没有内置登录**，绑 0.0.0.0 等于把「能读写文件、能跑命令」的界面交给同网段。
- `Handler._check_auth()` 目前恒返回 True（历史遗留的占位）。因此：
  - 局域网/公网访问必须在前置反向代理做认证（Basic / OIDC / IP 白名单），或只走手机配对通道；
  - 不要把 9890 直接映射到公网；
  - 隧道（`/dsh`）属于同一类暴露面，同样依赖前置层。
- 这条不是 TODO 清单，是当前事实：改鉴权前，任何「对外开放」都要自己加一层门。

## 5. 目录约定

```
根目录      只放：入口脚本（server.py / desktop.py / *.bat）、被 import 的顶层 .py、README/PROJECT.md
scripts\    辅助 bat（起停手机通道、启动肥鱼语音、放行防火墙）
logs\       运行日志（start.bat 已指向这里，-u 无缓冲）
public\     网页 UI + vendor\
phone-bridge\ 手机通道（Node）+ runtime\（含 state.json/token、dsh_admin.pem）
data\       chat.db、tool_outputs 等运行态
_ref\       参考资料（63 处代码引用，别删）
_backup\ _build\ tmp\ voice-out\  本机调试与历史存档（已 gitignore）
```

## 6. 排障顺序（事故后总结）

1. `python -c "import server"` —— 顶层 import 链是否完整（最快发现缺模块）。
2. `http://127.0.0.1:9890/` 是否 200、`public\vendor\` 是否 7 个文件都在。
3. `GET http://127.0.0.1:8899/api/link/state`（带 `x-phone-token`）看隧道；`running:false` 就先修 `tunnel.json`。
4. 公网 502 但本机 200 → 私钥权限（`ssh -v` 报 `UNPROTECTED PRIVATE KEY FILE`）+ 隧道未起，两条都查。
5. 日志里 `[embedder] ONNX model not found` → `models\bge_small_zh\` 缺失（按 `D:\dsh-rescue\STRUCTURE.md` 的下载命令恢复）。
6. 重定向的日志（`python server.py > logs\x.log`）是 **UTF-8**；Windows PowerShell 5.1 的 `Get-Content`
   默认按 ANSI 读，要加 `-Encoding UTF8`，否则看到的是「澶х溂X」这种假乱码。

### 6.0.1 `.bat` 里别写中文

cmd.exe 解析批处理时按系统 ANSI（简中为 GBK）读文件，UTF-8 写的中文会把同行的 `errorlevel` 这类命令名吃掉一半，报成 `'rrorlevel' is not recognized`。批处理里一律用英文提示；要输出中文就改走 Python / PowerShell。

### 6.0.2 改代码：按函数锚定，别只按片段

同一个片段可能在多个函数里出现。2026-11-14 修 `asset_v3.delete_entry` 时，`if not os.path.isfile(fp): raise ...` 在 `read_text` 里有一模一样的一份，按片段替换把 `read_text` 改成了「读不到文件就删登记」，而真正要改的函数没动 —— `assert old in s` 只保证"存在"，不保证"唯一"。

写法：先 `s.count(old) == 1`；否则把函数名/相邻行一起写进锚点，或者按 `s.index("def foo(")` 切片替换。改完必须 `py_compile` + 跑一条真调用，不要只看"脚本打印 ok"。

### 6.0.4 改函数别把 async 弄丢（2026-11-14）

按 `function loadRecycleBin(){` 当锚点替换，会命中 `async function loadRecycleBin(){` 的尾巴 —— 把 `async` 留在原地、新函数没了 `async`，页面报
`SyntaxError: await is only valid in async functions`（`check-desktop-js` 报 BLOCK 0）。更阴的是把注释插到那个位置，变成 `async // 注释`，运行时报 `ReferenceError: async is not defined`。
做法：锚点带上行首与 `async`（`\nasync function X(){`），或改完立刻 `python scripts\check-desktop-js.py` + 在页面里点一次那个功能。

### 6.0.3 写中文文件：用 Python，别用 PowerShell 管道

`Add-Content` / `Out-File` 在这台机器的 PowerShell 上按 ANSI 读字符串，把 UTF-8 的中文写成双重编码（读出来是「鏀规硶涓€琛」这种）。写 `.md`、`.json`、`.py` 里的中文一律用 Python：

```
python -c "import io; io.open(p,'w',encoding='utf-8').write(text)"
```

临时文件用 `write` 工具写好后，也用 Python 读进来再追加，别过 `Get-Content | Add-Content`。验证要连着读一遍：能看见正常汉字才算写了。

## 6.1 自检（改完先跑这三条）

```
python -m py_compile server.py            # 后端语法（连同 tools\ 一起编译更稳）
cd phone-bridge && npm run check          # 16 个内联 script 语法
node scripts\ui-smoke.mjs                 # 70 项界面冒烟（无头 Edge，零依赖）
node scripts\phone-smoke.mjs              # 手机端 7 项冒烟（自动读 runtime 的端口与 token）
node scripts\api-smoke.mjs                # 后端 121 项冒烟（越权删除/改名必须 403、记忆与晶体接口、回收站还原）
python scripts\check-desktop-js.py        # 桌面端内联脚本语法检查（语法错会让整块主脚本静默失效）
python tools\selftest_memory_clear.py     # 清空记忆必须连带清关系/实体（临时库，不碰真库）
python tools\selftest_pages_content.py    # 知识页 content 列必须是 str（曾经塞 list 直接炸）
python tools\selftest_crystal_recall.py   # 晶体召回带分数、不带 embedding/正文
python tools\selftest_file_versions.py    # AI 文件版本链能列出与恢复
python tools\selftest_versions.py         # 代码存档：只留 12 份 / 可疑 zip 拒绝 / 同秒不重名
python tools\selftest_netnote.py          # 网络错误翻成中文（且兜底必须是 ASCII）
scripts\check-all.bat                     # 一把跑完（--full 连冒烟），新机器上最省事
```

`/api/health` 给的是本地零网络信息：`status / pid / bridge_ready / app / version / started_at /
uptime_sec / python / platform / build(前端指纹) / disk{free_gb,total_gb} / db_bytes / rate_source`，
适合给外部监控探活，不会因为外网不通而变红。

## 7. 已知待办

- `D:\document\Remote Connect DSH` 的 `.py` 仍平铺在根目录（十几个），分目录重构需改 import，**未做**。
- `phone-bridge` 隧道靠 `link.mjs` 自带重试；僵尸 ssh 占 18899 时 `ensure_running(fresh=True)` 不会清（`kill_legacy_supervisor()` 保守返回 0）。
- `vsee.ask` 当前无云端视觉密钥，会抛清晰中文错误，直到在模型配置里填 key。
