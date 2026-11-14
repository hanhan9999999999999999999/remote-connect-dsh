# 手机通道（phone-bridge）

「手机通道」让手机浏览器打开电脑上的 DSH：二维码配对、局域网直连、或走你自己的公网域名。

## 它由两半组成

| 半 | 在哪 | 干什么 |
| --- | --- | --- |
| 开关 + 路由 | 本插件 `host/phone.mjs` | 启停桥接、换端口、发配对码、查地址，注册 `/dsh-phone-api/*` |
| 隧道 + 会话 | 你机器上的 `phone-bridge/` 目录 | 起 HTTP 服务、维护会话、跑 `ensure-running.ps1` 守护 |

插件不打包 `phone-bridge`：它是每台机器自己的运行态，跟你的路径、端口、域名、私钥绑在一起，
塞进 npm 包既搬不动也没意义。

## 目录要求

`bridgeDir` 里至少要有一个：

- `ensure-running.ps1` — 守护脚本（Windows 上插件用它拉起桥接）
- `server.mjs` — 直接用 node 起服务

`runtime/` 下会生成 `state.json`、`port.json`、`paused.flag`，别手删。
`tunnel.json`（如果走公网域名）在 `bridgeDir` 根上。

## 配置

```yaml
dsh-remote-connect:
  bridgeDir: '/path/to/phone-bridge'
```

优先级：`config.bridgeDir` > `config.dir` > 环境变量 `DSH_PHONE_BRIDGE_DIR` > 自动探测 > 旧默认路径。

自动探测只认「真的装好了」的目录（里面有 `ensure-running.ps1` 或 `server.mjs`），依次看：
`$DSH_HOME/phone-bridge`、当前工作目录下的 `phone-bridge`、旧的创作机路径。
所以把 `phone-bridge/` 放在 DSH 数据目录旁边或启动目录旁边，就不用写配置。

判断「装了没有」只看文件在不在，不看进程：缺 `ensure-running.ps1` 和 `server.mjs` 就报
「本机还没装手机通道」，并在 `hint` 里给出当前找的路径。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-phone-api/status` | 运行状态、端口、公网地址、配对码、地址列表 |
| POST | `/dsh-phone-api/start` | 清掉 `paused.flag` 并拉起桥接 |
| POST | `/dsh-phone-api/stop` | 写 `paused.flag` 并杀掉监听进程（守护脚本不会自动拉回） |
| POST | `/dsh-phone-api/port` | 换端口 |
| POST | `/dsh-phone-api/paircode` | 重新生成配对码 |

设置页的「手机通道」页签调的是 `/dsh-remote-connect-api/phone/*`，在**同一个进程里**直连上面这些函数，
不走 `127.0.0.1` 回环——回环请求没有 renderer token，会被浏览器访问策略挡成 403。

## 状态字段

`status` 返回的组合大致是：

```json
{
  "ok": true,
  "bridgeDir": "...",
  "installed": true,
  "port": 9890,
  "running": true,
  "pid": 12345,
  "paused": false,
  "publicUrl": "https://example.com/dsh",
  "pairCode": "123456",
  "addresses": ["192.168.1.10"],
  "mode": "lan"
}
```

`installed: false` 表示这台机器上还没有 `phone-bridge`，前端会显示安装提示而不是报错。

## 停用

在设置页点「停止」，或：

```powershell
New-Item "$bridgeDir/runtime/paused.flag" -Force | Out-Null
```

删掉 `paused.flag` 或调 `/start` 就恢复。
