# dsh-remote-connect

DSH 插件：**手机浏览器操作电脑上的 DSH**，以及**两台电脑之间同步插件 / 技能 / 规则 / 配置 / 会话**。

装好之后在 **DSH → 设置 → 远程互联** 里操作，五个页签：概览 / 连接 / 同步 / 手机通道 / 诊断。

## 装

```bash
# 从市场索引装（DSH → 设置 → 插件 → 发现，加索引源后点安装）
https://raw.githubusercontent.com/hanhan9999999999999999999/remote-connect-dsh/main/index.json

# 或者直接钉版本装
pnpm add "git+https://github.com/hanhan9999999999999999999/remote-connect-dsh.git#v1.0.44&path:/plugins/dsh-remote-connect"

# 或者拷到 profile 的 plugins 目录，再跑一次自带安装器
node scripts/install.mjs --profile <profile 名>      # --dry-run 先看要写什么
```

`npm` 装不了 git 子目录（会报 `ENOENT … package.json`），用 `pnpm`，或上面的拷贝方式。

## 两件事

| 能力 | 用法 | 前提 |
| --- | --- | --- |
| 📱 手机通道 | 手机扫码连上这台电脑的 DSH，浏览器里直接对话 | 本机有一份 `phone-bridge` 目录 |
| 💻 电脑互联 | 两台电脑配对后互相同步插件 / 技能 / 规则 / 配置 / 会话 | 两台都装本插件，同网段或能直连 |

手机通道的桥接目录按这个顺序找，都不用手动配：

```
config.bridgeDir  >  config.dir  >  环境变量 DSH_PHONE_BRIDGE_DIR
  >  自动探测 $DSH_HOME/phone-bridge、./phone-bridge、~/phone-bridge
  >  第一个候选目录
```

自动探测只认里面真有 `ensure-running.ps1` 或 `server.mjs` 的目录；一个都没有时页签会显示
「本机还没装手机通道」并告诉你它在找哪儿，不会甩一个 ENOENT 给你。细节见 [docs/PHONE.md](docs/PHONE.md)。

## 接口

本机路由挂在 `/dsh-remote-connect-api/*` 下共 30 条，手机通道另有 `/dsh-phone-api/*` 5 条；
两台电脑之间走 `/dsh-link/v1/*`（health / hello / inventory / export / apply / rollback / bye）。
完整清单在 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，`test/docs-guard.mjs` 会拿运行时注册的路由
去对文档，改了代码忘了改文档会红。

## 安全

- 配对走 scrypt + 挑战应答 + HKDF + HMAC 签名，帧用 AES-256-GCM；会话 12 小时，nonce 防重放。
- 同一 IP 连续失败 10 次锁 10 分钟。
- 同步默认排除依赖、缓存、日志、密钥、凭据；插件自身的数据目录永久排除。
- 威胁模型与边界见 [SECURITY.md](SECURITY.md)。

## 开发

```bash
node test/run-all.mjs     # 全量：client-smoke / inventory-guard / deps / bridge-dir / docs-guard / plugin-smoke / e2e
```

零第三方依赖，`node >= 20`。MIT，作者 茄茄子。
