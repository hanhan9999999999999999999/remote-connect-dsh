# dsh-remote-connect · 远程互联

一个 DSH 插件，两件事：

| 能力 | 你要的效果 |
| --- | --- |
| **手机通道** | 手机浏览器扫个码，就能操作电脑上正在跑的 DSH（发消息、看会话、传文件） |
| **电脑 ↔ 电脑** | 两台装了同一个插件的 DSH 互相发现、配对，把插件 / 技能 / 规则 / 配置 / 会话一键搬过去 |

设置入口：**DSH → 设置 → 远程互联**，含「概览 / 连接 / 同步 / 手机通道 / 诊断」五个页签。

> 之前的 `dsh-device-link`、`dsh-phone-bridge`、`dsh-prompt-inject` 三个插件已经合并成这一个包。
> `dsh-prompt-inject` 没有保留：它默认读 `~/.dsh/prompt-inject.md`，而 DSH 的数据目录早就可以不在那儿了，
> 大多数人也没有这个文件；注入系统提示词这件事更适合用 DSH 自己的指令文件做。

## 安装

### 方式一：走插件市场索引

在 DSH 的「设置 → 插件 → 发现 → 索引源」里加这一条：

```
https://raw.githubusercontent.com/hanhan9999999999999999999/remote-connect-dsh/main/index.json
```

（国内访问不顺可以换镜像：`https://cdn.jsdelivr.net/gh/hanhan9999999999999999999/remote-connect-dsh@main/index.json`）

索引里只有一个包，点安装即可。

### 方式二：直接从 git 装

```bash
pnpm add "git+https://github.com/hanhan9999999999999999999/remote-connect-dsh.git"
```

> 用 pnpm，不要用 npm：npm 不支持从 git 仓库的子目录安装，会报
> `ENOENT ... package.json`。

### 方式三：脚本装到本机 DSH

```bash
node scripts/install.mjs                  # 装进 $DSH_HOME/profiles/desktop
node scripts/install.mjs --profile work   # 指定 profile
node scripts/install.mjs --dry-run        # 只看会改什么
node scripts/install.mjs --uninstall      # 从 profile 里摘掉（保留文件）
```

脚本不重启 DSH，插件在下次启动 DSH 时生效。

## 手机通道要准备什么

插件本身只提供开关和路由，真正干活的是 **phone-bridge**（手机与电脑之间的隧道 + 会话服务）。
它默认在 `D:/document/Remote Connect DSH/phone-bridge`，里面要有 `ensure-running.ps1` 与 `runtime/`。

路径不一样就改插件配置：

```yaml
# cordis 配置里
dsh-remote-connect:
  bridgeDir: 'E:/somewhere/phone-bridge'
```

或设环境变量 `DSH_PHONE_BRIDGE_DIR`，`bridgeDir` 优先。

没装 phone-bridge 时「手机通道」页签会明确告诉你「这台电脑上没有手机通道目录」，
其余功能（配对、同步）照常可用，不会因为缺手机通道就整个挂掉。

细节见 [`plugins/dsh-remote-connect/docs/PHONE.md`](plugins/dsh-remote-connect/docs/PHONE.md)。

## 安全边界

- 所有 HTTP 路由**同源可用**，不回 CORS 头，外部网页无法借浏览器驱动本服务。
- 配对用一次性配对码 + ECDH 协商出的会话密钥；密码只存 scrypt 派生值。
- 同步默认**不搬**依赖、缓存、日志、密钥、凭据；插件自己的数据目录永久排除。
- 手机通道的隧道走你自己的服务器或内网，公网暴露面由你决定。

完整的威胁模型见 [`SECURITY.md`](plugins/dsh-remote-connect/SECURITY.md)。

## 目录

```
plugins/dsh-remote-connect/
├── index.js              host 半：/dsh-remote-connect-api/* 与 /dsh-phone-api/*
├── client.js             浏览器半：设置页「远程互联」
├── host/                 服务、发现、配对、打包、传输、同步、手机通道
├── locale/               zh / en
├── docs/ARCHITECTURE.md  设计说明
├── docs/PHONE.md         手机通道怎么配
├── scripts/install.mjs   本机安装脚本
└── test/                 单测与冒烟
```

## 许可

MIT，见 [LICENSE](LICENSE)。
