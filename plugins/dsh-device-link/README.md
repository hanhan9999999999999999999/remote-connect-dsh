# 设备互联 · Device Link

> 在 DSH 设置里点几下，把一台电脑上的插件、技能、规则、配置和对话记录搬到另一台电脑。
> 局域网自动发现，公网用密码直连；不用打包、不用 U 盘、不用手动对目录。

---

## 它解决什么问题

DSH 的能力散落在 `~/.dsh` 里：插件在 `plugins/`，技能在 `skills/`，全局规则在
`prompt-inject.md`，会话在 `sessions/`，profile 依赖在 `profiles/<name>/package.json`。
换一台电脑，或者想让台式机和笔记本保持一致，通常只能整目录拷贝——体积大、容易带上密钥、
还会把对端自己的插件依赖覆盖掉。

设备互联把这件事变成设置页里的一个按钮：

- **只传该传的**：默认排除 `node_modules`、`.git`、缓存、日志、密钥与凭据文件；
- **不覆盖对端**：同名文件先备份再写入，profile 依赖做合并而不是替换；
- **可回滚**：每次接收都有 journal，一键撤销整批；
- **有进度**：哈希、上传、应用、完成四个阶段实时可见；
- **双向**：A 可以拉 B，B 也可以推 A。

---

## 功能

### 设置页

DSH → 设置 → **设备互联**，五个页签：

| 页签 | 内容 |
| --- | --- |
| 概览 | 服务开关、监听端口、设备名、局域网地址、连接密码（显示/复制/轮换）、连接串、在线设备与最近同步 |
| 连接 | 局域网扫描、手动 host/port/密码连接、本机监听设置、已配对设备（测速/断开/忘记） |
| 同步 | 选择目标设备、推送或拉取、六类数据复选、对端清单预览、任务进度、取消、接收记录与回滚 |
| 手机通道 | 复用 `dsh-phone-bridge`：启停、端口、配对码、局域网与公网地址 |
| 诊断 | 10 项环境自检、插件依赖体检与一键补齐、版本与路径、日志、一键复制诊断报告 |

### 连接方式

- **局域网**：UDP 广播自动发现同网段设备，点一下即可配对；
- **手动地址**：知道 IP 和端口就能连，跨网段、VPN、ZeroTier/Tailscale 都适用；
- **公网**：把 8788 端口通过反向代理或 SSH 隧道暴露出去，用密码连接；也支持 `https://` 与自签证书；
- **连接串**：`dshlink://HOST:PORT?name=…&pwd=…&v=1`，复制给另一台电脑即可导入。

### 同步范围

| 分类 | 默认 | 内容 |
| --- | --- | --- |
| `skills` | ✅ | `skills/`、`skills-index.md`、`skills-manifest.json`、`skills-sync.mjs` |
| `rules` | ✅ | `prompt-inject.md`、`prompt-reminder.md`、`cordis.patch.yml`、`.agent-presets/` |
| `plugins` | ✅ | `plugins/` 源码（不含 `node_modules`）＋各 profile 的依赖清单（合并写入）；缺依赖的插件可在诊断页补齐 |
| `config` | ✅ | `profiles/`、`storages/` 与顶层配置 JSON |
| `sessions` | ✅ | `sessions/` 对话记录 |
| `plugin-data` | ⬜ | `plugins-data/`、记忆与看屏等插件数据（体积大，默认关闭） |

排除规则（始终生效，除非显式开启“包含凭据”）：

- 目录：`node_modules`、`.git`、`__pycache__`、`.cache`、`dist`、`build`、`coverage`；
- 文件：`*.log`、`*.tmp`、`*.part`、`*.map`、`.DS_Store`；
- 凭据：`.credentials.yaml`、`.dshw-api.json`、`model_config.json`、`.env`、`*.pem/key/p12/pfx`、`id_rsa`；
- 缓存：`storages/session_projcache/`。

### 插件依赖

插件源码默认不携带 `node_modules`：它通常很大，而且可能包含只适用于某一平台的原生二进制。
接收端如果发现某个插件声明了依赖却没有安装，会把它列进 **诊断 → 插件依赖**；
点“补齐”只在该插件目录执行一次 `npm install --omit=dev --no-audit --no-fund`，
不修改插件源码，也不会静默执行。补装由用户显式触发，失败会保留 npm 的原始输出供排查。

### 合并与回滚

- 每个文件带 SHA-256；内容相同直接跳过，不做无谓写入；
- 覆盖前备份到 `~/.dsh/plugins-data/dsh-device-link/backups/<syncId>/`；
- profile 的 `package.json` 走 `merge-profile`：保留本机 `name`、`identity` 和本地依赖，
  只把对端依赖与 `dsh.profile.bundles` 并进来；
- 接收完成后生成 `journal.json`；“本机接收记录”里可整批回滚；
- 备份保留最近 5 批（可配置）。

---

## 安装

### 一键脚本（推荐）

```bash
cd plugins/dsh-device-link
node scripts/install.mjs
```

脚本会：

1. 把插件复制到 `~/.dsh/plugins/dsh-device-link`；
2. 在 `~/.dsh/profiles/desktop/package.json` 里加入
   `"@local/dsh-device-link": "file:../../plugins/dsh-device-link"`；
3. 把 `@local/dsh-device-link` 追加到 `dsh.profile.bundles`；
4. 在 profile 的 `node_modules/@local/` 下创建目录联接（失败则复制）；
5. 备份原 `package.json` 为 `package.json.bak-<时间戳>`。

选项：

```bash
node scripts/install.mjs --profile work      # 安装到另一个 profile
node scripts/install.mjs --dry-run           # 只显示将要做的改动
node scripts/install.mjs --uninstall         # 从 profile 移除（保留文件）
node scripts/install.mjs --uninstall --purge # 连同插件文件一起删除
```

> 安装器**不会**重启 DSH。请手动退出并重新打开 DSH，插件才会加载。

### 手动安装

1. 复制目录到 `~/.dsh/plugins/dsh-device-link`；
2. 编辑 `~/.dsh/profiles/<profile>/package.json`：
   - `dependencies["@local/dsh-device-link"] = "file:../../plugins/dsh-device-link"`
   - `dsh.profile.bundles` 追加 `"@local/dsh-device-link"`
3. 在 `node_modules/@local/` 下建立指向插件目录的联接；
4. 重启 DSH。

### 环境要求

- DSH `0.2.x`（桌面版或 Web 版）；
- Node.js `>= 20`（插件随 DSH 的 Electron 运行时加载，无需单独安装 Node）；
- 同步端口默认 **8788/TCP**；局域网发现另用 **8788/UDP**。

---

## 快速开始

### 同一局域网

1. 两台电脑都安装本插件并重启 DSH；
2. A：设置 → 设备互联 → 概览，确认服务已启动，记下密码；
3. B：设置 → 设备互联 → 连接 → 扫描局域网，选中 A；
4. 输入 A 的密码 → 连接；
5. B：同步 → 选择 A → 选择“从对端拉取” → 勾选分类 → 开始同步。

### 公网

任选一种把 A 的 8788 暴露给 B：

```bash
# 方式一：SSH 反向隧道（最省事，自带加密）
ssh -R 18788:127.0.0.1:8788 user@public-host
# B 连接 public-host:18788
```

```nginx
# 方式二：Nginx 反向代理 + TLS
server {
  listen 443 ssl;
  server_name dsh.example.com;
  ssl_certificate     /etc/ssl/fullchain.pem;
  ssl_certificate_key /etc/ssl/privkey.pem;
  location / {
    proxy_pass http://127.0.0.1:8788;
    proxy_http_version 1.1;
    proxy_request_buffering off;   # 流式上传必需
    proxy_buffering off;           # 流式下载必需
    client_max_body_size 0;
  }
}
```

B 在“连接”页填 `dsh.example.com`、`443`，协议选 `https`，输入密码即可。

> 不要直接把明文 HTTP 端口映射到公网。密码握手本身不传输明文密码，但同步内容
> 只做了应用层加密；没有 TLS 时，元数据与流量特征仍然可被观察。

---

## 安全模型（摘要）

1. **密码不落网**：scrypt(N=2¹⁴, r=8, p=1) 派生主密钥，挑战-应答证明身份；
2. **会话密钥**：HKDF-SHA256（双 nonce）派生，服务端不保存主密钥；
3. **请求签名**：`HMAC-SK(method|path|ts|nonce|sha256(body))`，5 分钟时间窗 + nonce 防重放；
4. **报文加密**：AES-256-GCM，逐帧独立 IV 与序号 AAD；
5. **会话 12 小时**，改密码立即失效；连续 10 次失败锁定 10 分钟；
6. **无 CORS 头**，浏览器跨站页面无法驱动本机服务；
7. 密码以明文保存在本机 `config.json`（0600），因为设置页需要显示给用户抄到另一台机器。
   这是“可读回”与“本地磁盘被攻破”之间的取舍，详见 [SECURITY.md](SECURITY.md)。

---

## 常见问题

**扫描不到设备？**
确认两台机器在同一网段、防火墙放行 8788/UDP；或直接用“手动连接”填 IP。

**连接被拒绝 / 超时？**
先 `curl http://HOST:8788/dsh-link/v1/health`。没有响应就是端口/防火墙/隧道问题；
返回 `app` 不是“设备互联”说明对端不是本插件。

**密码错误几次后连不上了？**
服务端有 10 次失败锁定，等 10 分钟，或在概览页轮换密码。

**同步特别大？**
`plugin-data` 默认关闭；`sessions` 可能数百 MB；单文件上限 512 MB、整批 8 GB，
都可以在设置页调整。

**接收端提示“校验失败”？**
传输过程中文件被改动或磁盘写入异常。该批不会落盘，检查磁盘空间后重试。

**手机通道页显示未安装？**
说明没有装 `dsh-phone-bridge`。本插件只做代理，不内置手机通道。

**装完设置页没有“设备互联”？**
插件在 DSH 启动时加载，必须重启 DSH；并确认 profile 的 `bundles` 里有
`@local/dsh-device-link`。

---

## 目录结构

```
plugins/dsh-device-link/
├── index.js              # 宿主入口：挂载 /dsh-device-link-api/*
├── client.js             # 设置页（React，无构建）
├── host/
│   ├── config.mjs        # 配置、身份、连接串
│   ├── crypto.mjs        # scrypt / HKDF / HMAC / AES-GCM / 帧
│   ├── tar.mjs           # ustar + pax 打包与解析
│   ├── inventory.mjs     # 六类数据扫描与排除
│   ├── pack.mjs          # 哈希缓存、清单、tar.gz
│   ├── frames.mjs        # 加密帧流
│   ├── apply.mjs         # 校验、备份、落盘、journal、回滚
│   ├── discovery.mjs     # UDP 局域网发现
│   ├── server.mjs        # /dsh-link/v1 服务端
│   ├── peer.mjs          # 对端客户端
│   ├── peers.mjs         # 已配对设备存储
│   └── service.mjs       # 编排层
├── scripts/install.mjs   # 安装器
├── test/                 # 客户端、插件挂载、双进程端到端
├── docs/ARCHITECTURE.md  # 架构与协议
├── SECURITY.md
└── CHANGELOG.md
```

---

## 开发与测试

```bash
node test/client-smoke.mjs    # 加载 client.js，校验槽位与中英词条
node test/plugin-smoke.mjs    # 挂载 index.js，跑真实 HTTP 路由
node test/e2e.mjs             # 两个进程、两个 DSH_HOME 的完整同步
```

端到端测试覆盖：健康检查、错误密码、握手、会话复用、清单、拉取、排除规则、
profile 合并、反向上传、回滚、断开。

---

## 兼容性

- Windows 10/11、macOS 12+、Linux（x64/arm64）；
- 中文/英文界面跟随 DSH 语言；
- 传输压缩使用 gzip（兼容 Electron 自带 Node，不依赖 zstd）；
- 协议版本 `dsh-link/v1`，握手时校验，版本不一致会明确报错。

## License

MIT
