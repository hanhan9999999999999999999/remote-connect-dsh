# dsh-remote-connect

[![test](https://github.com/hanhan9999999999999999999/remote-connect-dsh/actions/workflows/test.yml/badge.svg)](https://github.com/hanhan9999999999999999999/remote-connect-dsh/actions/workflows/test.yml)

> DSH 插件：**用手机远程操作电脑上的 DSH**，以及**两台电脑之间互相同步**插件 / 技能 / 规则 / 配置 / 会话。

装在 DSH 里之后，设置页会多出一个 **「远程互联」** 分区，两个能力都在里面。

| 能力 | 做什么 | 入口 |
| --- | --- | --- |
| 📱 **手机通道** | 手机浏览器直接打开电脑上的 DSH：二维码配对、局域网直连，或走你自己的公网域名 | 设置 → 远程互联 → 手机通道 |
| 💻 **电脑互联** | 两台电脑互扫配对，同步插件 / 技能 / 规则 / 配置 / 会话，随时可回滚 | 设置 → 远程互联 → 互联 |

- 插件名：`dsh-remote-connect`
- 版本：1.0.13
- 许可证：MIT
- 需要的 DSH：带 `webServer` 服务、客户端支持 `settings.section` 插槽的版本

---

## 安装

### 方式一：从市场索引装（推荐）

DSH → 插件市场 → 索引源，填：

```
https://raw.githubusercontent.com/hanhan9999999999999999999/remote-connect-dsh/main/index.json
```

这条是**主地址**：推完一般几十秒就能看到新版本。

国内网络打不开 raw 时，可以换 jsDelivr 镜像：

```
https://cdn.jsdelivr.net/gh/hanhan9999999999999999999/remote-connect-dsh@main/index.json
```

> ⚠ **jsDelivr 是镜像，会滞后。** 我们对它实测过：`s-maxage=43200`（12 小时）加上不同边缘节点各存各的，
> 同一时刻不同人看到的可能是 1.0.0 / 1.0.2 / 最新版三种。刚发完版就换索引源、又恰好命中旧节点，
> 就会以为「怎么装到的还是旧版」。要「现在就是最新」，用上面的 raw 地址；要「永远是某一版」，
> 用下面的 git 直装并钉标签或 40 位 SHA。

索引里只有这一个插件，版本 `1.0.13`，来源是本仓库的 `plugins/dsh-remote-connect` 子目录。

### 方式二：用 git 直装

插件在 monorepo 子目录里，`npm` 装不了（它不支持 git 子目录），用 pnpm：

```powershell
# 用发行标签装（推荐，标签指向这一版的发布提交）
pnpm add "git+https://github.com/hanhan9999999999999999999/remote-connect-dsh.git#v1.0.13&path:/plugins/dsh-remote-connect"
```

想钉死某个 commit 也可以，把 `#v1.0.13` 换成 40 位 SHA；`index.json` 里钉的就是同一版的具体
commit（社区市场要求 40 位 SHA），两者由发版流程一起更新，见 `RELEASING.md` 第 5 节。

### 方式三：手动放进 profile

```powershell
# 把仓库里的插件目录拷进当前 profile 的 node_modules
Copy-Item -Recurse .\plugins\dsh-remote-connect "$env:DSH_HOME\profiles\desktop\node_modules\dsh-remote-connect"
```

包内自带 `scripts/install.mjs`，也可以用：

```powershell
node .\plugins\dsh-remote-connect\scripts\install.mjs --dry-run   # 先看要写什么，不落盘
node .\plugins\dsh-remote-connect\scripts\install.mjs             # 真装
node .\plugins\dsh-remote-connect\scripts\install.mjs --purge     # 连插件文件一起卸掉
node .\plugins\dsh-remote-connect\scripts\install.mjs --help      # 全部参数
```

它只改 `$DSH_HOME\plugins\` 与 profile 的 `package.json`（改前留 `.bak-<时间戳>`），**不会重启 DSH**。

装完重启 DSH，进 设置 → 远程互联。

---

## 手机通道怎么用

1. 电脑上装好本插件，DSH 开着；
2. 设置 → 远程互联 → **手机通道** → 点「启动」，拿到二维码 / 配对码；
3. 手机连同一个 Wi-Fi，浏览器扫码打开；不在同一网段就走公网域名（见下）。

**手机通道需要有 `phone-bridge/` 目录**——它是每台机器自己的运行态（路径、端口、域名、私钥都绑在这上面），插件不打包它。目录里至少要有 `ensure-running.ps1` 或 `server.mjs`。

路径优先级：

```
config.bridgeDir  >  config.dir  >  环境变量 DSH_PHONE_BRIDGE_DIR
                  >  自动探测（$DSH_HOME/phone-bridge、./phone-bridge、~/phone-bridge）
                  >  第一个候选目录（找不到就显示「还没装手机通道」，不报 ENOENT）
```

自动探测只认真的装好的目录（里面有 `ensure-running.ps1` 或 `server.mjs`），所以把 `phone-bridge/` 放在 DSH 数据目录或启动目录旁边就不用配了。

配置写在 DSH 插件配置里：

```yaml
dsh-remote-connect:
  bridgeDir: '/path/to/phone-bridge'
```

没装 `phone-bridge` 时不会报错，面板显示「本机还没装手机通道」并给出当前找的路径。

细节（接口、状态字段、停用方式）：[plugins/dsh-remote-connect/docs/PHONE.md](plugins/dsh-remote-connect/docs/PHONE.md)

---

## 电脑互联怎么用

1. 两台电脑都装本插件，各自在 设置 → 远程互联 里设设备名和密码；
2. A 点「发现」或直接填 B 的地址 → 配对；
3. 配对后在 A 上勾选要同步的类别（插件 / 技能 / 规则 / 配置 / 会话），点「推送」或「拉取」；
4. 每次同步都有记录，`回滚` 可以退回上一份。

同步走的接口一览（前缀 `/dsh-remote-connect-api`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/status` | 本机互联状态、设备名、端口 |
| GET | `/diagnostics` | 诊断信息 |
| GET | `/logs` | 最近 300 行日志 |
| POST | `/config` | 改配置 |
| GET | `/deps` · POST `/deps/install` | 依赖检查 / 安装 |
| POST | `/device/name` | 改设备名 |
| POST | `/password/set` · `/password/rotate` | 设密码 / 换密码 |
| POST | `/server/start` · `/server/stop` | 起停互联服务 |
| POST | `/discover` · `/connect` | 发现对端 / 配对连接 |
| POST | `/peer/disconnect` · `/peer/forget` · `/peer/rename` · `/peer/probe` | 对端管理 |
| POST | `/inventory` · `/sync` | 列出可同步内容 / 开始同步 |
| POST | `/task/status` · `/task/cancel` | 同步任务进度 / 取消 |
| POST | `/local/syncs` · `/local/rollback` | 本机同步记录 / 回滚 |
| POST | `/remote/syncs` · `/remote/rollback` | 对端同步记录 / 回滚 |
| GET | `/phone/status` · `/phone/port` · `/phone/paircode` | 手机通道代理（同进程直连） |
| POST | `/phone/start` · `/phone/stop` | 手机通道启停 |

手机通道自身还注册了一组 `/dsh-phone-api/*`（`status` / `start` / `stop` / `port` / `paircode`）。

**为什么面板走 `/dsh-remote-connect-api/phone/*` 而不是 `127.0.0.1`**：回环请求没有 renderer token，会被浏览器访问策略挡成 403，所以面板和桥接在同一进程里直连函数。

---

## 目录结构

```
plugins/dsh-remote-connect/
├── index.js              Host 半：注册 /dsh-remote-connect-api/*，挂载手机通道
├── client.js             客户端半：设置页「远程互联」分区（slots/设置/locale）
├── host/
│   ├── service.mjs       互联服务：配对、同步、回滚（编排）
│   ├── tasks.mjs         同步任务表（内存、上限 40 条、按开始时间淘汰）
│   ├── peer.mjs/peers.mjs 对端握手、探测、对端表
│   ├── discovery.mjs     局域网发现
│   ├── inventory.mjs     可同步内容清点
│   ├── pack.mjs/tar.mjs 打包与解包
│   ├── crypto.mjs        配对码 / 密码派生
│   ├── frames.mjs        传输分帧
│   ├── phone.mjs         手机通道：启停编排、状态、配对码
│   ├── port-scan.mjs     端口窥探：解析 netstat、认领桥接进程、挑空端口
│   ├── server.mjs        互联 HTTP 服务
│   ├── guard.mjs         连接守卫：IP 提取、设备字段清洗、失败锁定、签名窗口
│   ├── apply.mjs/config.mjs/deps.mjs/util.mjs  装配、配置、依赖、常量
├── locale/{zh,en}.json   文案（分区名「远程互联」/ Remote Connect）
├── docs/{PHONE,ARCHITECTURE}.md
├── cordis.patch.yml      插件清单补丁
└── test/                 客户端冒烟、清单守卫、依赖、路由、端到端
```

---

## 开发与测试

```powershell
cd plugins/dsh-remote-connect
node test/run-all.mjs          # 插件全套（约 10 秒）
node ../../tools/validate-index.mjs   # 市场索引校验（无依赖）
```

包含：客户端冒烟（插槽/文案/顺序）、清单守卫（`files` 与实际文件一致）、依赖声明、路由（35 条断言 + 手机通道 5 条）、端到端（health / pull / push / rollback）。全部用临时目录，不碰你真机的数据。

CI 在 `.github/workflows/test.yml`：ubuntu + windows × node 20/22，克隆下来就能看到结果；索引校验与插件测试都会跑。

改完插件后的发版流程（改版本 → 提代码 → 拿 SHA → 更新 `index.json` → 校验 → 实装验证 → 社区市场提 PR）写在 [RELEASING.md](RELEASING.md)。

---

## 安全边界

- 连接是**配对码 + 密码**双要素，配对后对端才会出现在列表里；
- 同步内容由你自己勾选，默认不包含任何密钥文件；
- 局域网 HTTP 是明文，信任模型写在 [plugins/dsh-remote-connect/SECURITY.md](plugins/dsh-remote-connect/SECURITY.md)；
- 走公网域名时用的是你自己的隧道和证书，别把私钥提交进仓库（本仓库 `.gitignore` 已排除 `runtime/`）。

---

## 相关

- [RELEASING.md](RELEASING.md) — 发版与上架手册
- [index.json](index.json) — DSH 插件市场索引（format 1）
- [LICENSE](LICENSE) — MIT
