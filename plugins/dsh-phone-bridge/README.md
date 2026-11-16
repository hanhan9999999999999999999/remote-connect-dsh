# dsh-phone-bridge（远程服务插件）

在 DSH 的输入框左侧加一颗「远程服务」药丸；点开面板可以**开启 / 关闭**手机通道、看到配对码与手机地址。

## 它在哪

| 用途 | 路径 |
| --- | --- |
| 源码（改这里） | `D:\document\Remote Connect DSH\plugins\dsh-phone-bridge\` |
| 安装副本（宿主读这里） | `<用户目录>\.dsh\profiles\desktop\node_modules\@local\dsh-phone-bridge` |
| 桥接本体 | `D:\document\Remote Connect DSH\phone-bridge\`（server.mjs / ensure-running.ps1 / runtime\） |

装法是手工的（没有 plugin_manager 工具，pnpm 路线会因 GitHub 依赖超时回滚）：
1. 源码逐文件 `copy2` 到安装副本；
2. profile 的 `package.json` 里 `dsh.profile.bundles` 加上 `@local/dsh-phone-bridge`；
3. **重启 DSH 应用**。

## 契约

| 端点 | 作用 |
| --- | --- |
| `GET /dsh-phone-api/status` | 运行状态、PID、模式、公网/局域网地址、配对码、会话 |
| `POST /dsh-phone-api/start` | 删除 `runtime\paused.flag` → 直连 spawn `node server.mjs`（失败回落 `ensure-running.ps1`），最多等 8 秒就返回，前端 5 秒轮询补齐 |
| `POST /dsh-phone-api/stop` | 先写 `runtime\paused.flag`，再 taskkill 掉 8899 的监听进程；守护 VBS 见到 flag 不再拉活 |
| `POST /dsh-phone-api/paircode` | `{code:"4-8 位数字"}` → 转发给桥接 `POST /api/pair-code`（桥接改内存 + 写 state.json，避免被内存值回写覆盖） |

客户端注册在槽位 `conversation.composer.dock`，`order: 5`。

## 两个坑（都踩过）

1. **改插件必须重启应用**：`cordis-plugin-loader` 没有 watch，也没有 reload 路由（`/dsh-plugin-manager/status` 404）。
   双击 `tools\restart-dsh.cmd` 就行。
2. **`paused.flag` 与守护脚本的约定**：`ensure-running.ps1` 只有带 `-Guard` 时才理 flag
   （守护 VBS 调用时带）；插件/人手调用不带，等于「这次是主动要开」，会清掉 flag 再启动。
   别把这个区分去掉，否则「关闭」会被守护 60 秒内拉活，或者「开启」被自己的 flag 挡住。

## 验收

```bat
node tools\verify-remote-service.mjs --port ^<GUI 端口^>
```
8 条全 PASS 即正常；其中「运行中的插件是新版」一条失败说明应用还没重启。
