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
┌──────────────────────────── DSH 主进程 ────────────────────────────┐
│  host/index.js  (cordis 插件)                                      │
│    ├─ 注册 /dsh-remote-connect/api/*   ← 设置页调用（同源 HTTP）       │
│    ├─ LinkService（单例）                                          │
│    │    ├─ SyncServer   :8788   TCP HTTP + UDP 发现                 │
│    │    ├─ PeerClient   连接远端 SyncServer                         │
│    │    ├─ Inventory    扫描 ~/.dsh → 分类清单                      │
│    │    ├─ Archiver     纯 JS tar + gzip（无依赖）                  │
│    │    └─ Applier      暂存 → 校验 → 备份 → 落盘 → 日志/回滚       │
│    └─ 日志环 / 任务表 / 配置                                       │
└────────────────────────────────────────────────────────────────────┘

        ▲ 同源 fetch                        ▲ HTTPS(可选) / HTTP + 应用层加密
        │                                   │
┌───────┴────────┐                 ┌────────┴─────────┐
│ 设置页 (React) │                 │ 另一台 DSH 的同款 │
└────────────────┘                 └──────────────────┘
```

为什么要自己起一个端口，而不是挂在 DSH 的 Web 服务上？

- DSH 的 Web 服务默认只监听回环，改它有风险；
- 同步服务需要长期在线、可被局域网访问、可单独开关；
- 端口冲突、防火墙、隧道都能独立处理，不牵连 DSH 本身。

## 3. 安全模型

三层，层层独立：

1. **连接密码**：默认随机生成 6 组 4 字符（`XXXX-XXXX-XXXX`），可改成任意自定义密码。
   派生 `scrypt(password, salt, N=2^14, r=8, p=1)` → 32 字节主密钥 `K`。
   `K` 从不落盘、从不上线；salt 存在本机配置里。
2. **握手**：`hello` 双向挑战（`clientNonce` / `serverNonce`），客户端提交
   `HMAC(K, "hello|clientNonce|serverNonce|deviceId")`，服务端常量时间校验。
   成功后服务端发一次性会话令牌（32B，默认 12 小时），并派生出会话密钥
   `SK = HKDF(K, "session|clientNonce|serverNonce")`。
3. **报文**：每个请求带 `x-dl-ts`、`x-dl-nonce`、`x-dl-mac = HMAC(SK, method|path|ts|nonce|sha256(body))`；
   请求/响应体用 `AES-256-GCM(SK)` 加密。时间偏移 > 300s 或 nonce 复用直接拒绝。

附加约束：

- 密码错误按 IP 指数退避（1s→2s→4s…上限 60s），连续失败 10 次锁 10 分钟；
- 所有路径在服务端二次校验（拒绝 `..`、绝对路径、盘符、保留名）；
- 单文件上限 512 MB、单次同步上限 8 GB（可配置），超出在清单阶段就拒绝；
- 默认**不传输** `.credentials.yaml`、`.dshw-api.json`、`model_config.json`、`*.pem`、`*.key`、
  `node_modules/`、`.git/`、日志、缓存；开启「包含凭据」需二次确认，且会在同步报告里单独标注。

## 4. 数据模型

同步内容按**分类**组织，每类有自己的扫描规则与排除规则：

| 分类 | 源路径（相对 `~/.dsh`） | 默认 | 说明 |
| --- | --- | --- | --- |
| `skills` | `skills/**`、`skills-index.md`、`skills-manifest.json`、`skills-sync.mjs` | 开 | 排除 `node_modules`、`.git`、>64MB 资源 |
| `rules` | `prompt-inject.md`、`prompt-reminder.md`、`cordis.patch.yml`、`.agent-presets/**` | 开 | 本地条款/预设 |
| `plugins` | `plugins/**`（排除 `node_modules`/`.git`/模型）+ profile 的 `package.json` 依赖与 `bundles` | 开 | 只同步**源码级**插件；注册表依赖生成「依赖清单」供对端一键补齐 |
| `config` | `profiles/*/cordis.yml`、`cordis.patch.yml`、`storages/**`（排除缓存）、若干 `*.json` 偏好 | 开 | 排除 `storages/session_projcache` |
| `sessions` | `sessions/**` | 开 | 会话存档（对话记录），保留工作区目录编码与 `session-*` 结构 |
| `plugin-data` | `plugins-data/**`、`meow-memory/`、`memory-nebula/*.db` 等小型数据 | 关 | 体积不可控，默认关，逐项勾选 |

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

## 5. 传输契约

### 5.1 服务端（被连接的一侧）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-link/v1/health` | 公开：版本、设备名、是否设密码、分类摘要（不含密钥） |
| POST | `/dsh-link/v1/hello` | 挑战应答，返回 `{token, expiresAt, server:{…}}` |
| GET | `/dsh-link/v1/inventory?cats=skills,rules` | 加密响应：清单 + 统计 |
| POST | `/dsh-link/v1/export` | 请求体 `{cats, manifestId}`；响应为 `tar.gz` 流（加密信封） |
| POST | `/dsh-link/v1/apply` | 请求体为 `tar.gz` 流；返回 `{syncId}`，进度由 `/progress` 查询 |
| GET | `/dsh-link/v1/progress?syncId=` | 应用进度（已写字节/总字节/当前文件） |
| POST | `/dsh-link/v1/rollback` | `{syncId}` 回滚一次应用 |
| GET | `/dsh-link/v1/ping` | 已认证心跳 |

### 5.2 本机插件路由（设置页用）

`/dsh-remote-connect/api/*`：`status`、`config`、`server/start|stop`、`discover`、`connect`、
`peers`、`disconnect`、`remote/inventory`、`sync/start`、`sync/progress`、`sync/cancel`、
`rollback`、`logs`、`phone/*`（转发 phone-bridge）、`diagnostics`。

## 6. 失败与恢复

| 场景 | 处理 |
| --- | --- |
| 端口被占 | 启动前探测；占用则报出占用者 PID/名称，并建议下一个空闲端口 |
| 对端离线 | 连接表保留，UI 显示灰点；定时重探（退避 5s→60s） |
| 传输中断 | 接收端保留 staging 目录与 journal；重连后可 `resume`（按 `sha256` 跳过已传文件） |
| 应用中断 | 下次启动扫描 `journal.json`，提示「上次同步未完成，可回滚」 |
| 磁盘不足 | 清单阶段检查可用空间（`statfs` 不可用时跳过并提示） |

## 7. 兼容性

- 协议带 `v1`，`/health` 返回 `protocol` 与 `app`；不兼容时 UI 明确报「对端版本过旧」。
- 插件不假设 DSH 内部 API，只用 `slots` 与 `webServer`；两者缺失时降级为「仅引擎」模式
  （路由不注册，但引擎仍可被脚本调用）。
- Windows / macOS / Linux 均可运行；路径处理一律走 `node:path` 与 `fileURLToPath`。
