# Changelog

所有值得注意的变更都记在这里。版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

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
