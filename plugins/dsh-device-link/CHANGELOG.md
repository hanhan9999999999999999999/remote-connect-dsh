# Changelog

所有值得注意的变更都记在这里。版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## 0.1.0 — 2026-11-12

首个可用版本。

### 新增

- **设置页**：DSH → 设置 → 设备互联，含概览 / 连接 / 同步 / 手机通道 / 诊断五个页签；
  中英双语，跟随 DSH 语言；使用 DSH 主题变量，支持浅色与深色。
- **互联服务**：默认监听 `8788/TCP`，端口占用时自动顺延（最多 12 个）；
  UDP 广播发现，同一网段自动列出设备。
- **配对**：scrypt 派生 + 挑战应答 + HKDF 会话密钥 + HMAC 请求签名 + AES-256-GCM 帧加密；
  12 小时会话、5 分钟时间窗、nonce 防重放、10 次失败锁定 10 分钟。
- **连接方式**：局域网扫描、手动 host/port、`https`（含自签证书）、`dshlink://` 连接串。
- **同步**：六类数据（skills / rules / plugins / config / sessions / plugin-data），
  双向推送与拉取、按类预览对端清单、实时进度、取消、断线报错本地化。
- **合并**：profile 的 `package.json` 采用并集合并，保留本机 identity、依赖与 bundles。
- **安全边界**：默认排除依赖、缓存、日志、密钥、凭据；永久排除设备互联自身的数据目录。
- **完整性**：逐文件 SHA-256、大小校验、临时文件原子替换、覆盖前备份、整批 journal 与回滚。
- **手机通道**：复用 `dsh-phone-bridge` 的 HTTP 接口，提供启停、端口、配对码与地址。
- **诊断**：10 项环境自检、插件依赖体检与显式补装（`npm install --omit=dev`）、结构化日志、一键复制报告。
- **安装器**：复制插件、写 profile 依赖与 bundles、创建目录联接、备份原 `package.json`；
  支持 `--dry-run`、`--profile`、`--uninstall`、`--purge`；不会自动重启 DSH。

### 测试

- `test/client-smoke.mjs`：加载客户端模块，校验 section/icon 槽位与 142 个中英词条对齐。
- `test/plugin-smoke.mjs`：在假 webServer 上挂载宿主入口，跑通 28 条路由、状态、诊断、
  密码轮换、手机通道降级、错误码映射。
- `test/inventory-guard.mjs`：确认自身状态、凭据、缓存不会被扫描进清单。
- `test/deps.mjs`：用本地 `file:` 依赖真实执行一次 npm 补装，验证检测、修复与插件 ID 校验。
- `test/e2e.mjs`：两个独立进程、两个独立 `DSH_HOME`，覆盖健康检查、错误密码、握手、
  会话复用、清单、拉取 9 个文件、排除规则、profile 合并、反向推送、回滚、断开。

### 已知限制

见 [SECURITY.md](SECURITY.md#8-已知限制)。
