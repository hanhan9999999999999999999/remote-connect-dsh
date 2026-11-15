/**
 * dsh-remote-connect — browser half.
 *
 * The Settings → 远程互联 page: local service controls, LAN/public pairing,
 * one-click sync of plugins / skills / rules / config / sessions, a phone
 * bridge tab, and diagnostics.
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-connect',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } = React

    const API = '/dsh-remote-connect-api'
    const NS = 'remoteConnect'

    // 后端统计用的是代号（secret / log / big），界面按当前语言翻译
    const EXCLUDE_LABEL = {
      secret: 'excl.secret',
      log: 'excl.log',
      big: 'excl.big',
  denied: 'excl.denied',
  deep: 'excl.deep',
      other: 'excl.other',
    }

    /* ------------------------------------------------------------------ */
    /* i18n                                                               */
    /* ------------------------------------------------------------------ */

    const zh = {
      nav: '远程互联',
      title: '远程互联',
      subtitle: '在两台电脑之间同步 DSH 的插件、技能、规则、配置与会话',
      'tabs.overview': '概览',
      'tabs.connect': '连接',
      'tabs.sync': '同步',
      'tabs.phone': '手机通道',
      'tabs.diagnostics': '诊断',
      'common.save': '保存',
      'common.saved': '已保存',
      'common.copy': '复制',
      'common.copied': '已复制',
      'common.copyFailed': '复制失败，请手动选中',
    'status.degraded': '有 {n} 块信息没取到，下面几处暂时不准：',
      'common.confirm': '确认？',
      'common.cancel': '取消',
      'common.refresh': '刷新',
      'common.retry': '重试',
      'common.loading': '加载中…',
      'common.none': '暂无',
      'common.show': '显示',
      'common.hide': '隐藏',
      'common.on': '开',
      'common.off': '关',
      'overview.service': '互联服务',
      'overview.running': '运行中',
      'overview.stopped': '已停止',
      'overview.port': '监听端口',
      'overview.bind': '监听地址',
      'overview.bindLan': '0.0.0.0 · 局域网可访问',
      'overview.bindLocal': '127.0.0.1 · 仅本机',
      'overview.identity': '本机身份',
      'overview.deviceName': '设备名称',
      'overview.renameHint': '另一台电脑配对时会看到这个名字',
      'overview.addresses': '局域网地址',
      'overview.addressHint': '对端可以手动输入其中任意一个地址',
      'overview.password': '连接密码',
      'overview.passwordHint': '对端连接这台电脑时需要输入它',
      'overview.rotate': '更换密码',
      'overview.rotateConfirm': '确认更换？旧连接会全部失效',
      'overview.copyInfo': '复制连接信息',
      'overview.uri': '连接串',
      'overview.uriHint': '在另一台电脑上粘贴这一串即可免手输地址',
      'overview.stats': '状态',
      'overview.peers': '已配对设备',
      'overview.cats': '同步分类',
      'overview.lastSync': '最近同步',
      'overview.enable': '启用互联服务',
      'overview.enableHint': '关闭后本机不再接受其他电脑的连接',
      'overview.discovery': '局域网发现',
      'overview.discoveryHint': '允许同网段设备自动发现本机',
      'overview.serverSection': '本机服务',
      'overview.never': '还没有同步过',
      'overview.ready': '已就绪',
      'connect.title': '连接另一台电脑',
      'connect.desc': '输入地址和密码；两台机器在同一网段时可以直接扫描发现',
      'connect.scan': '扫描局域网',
      'connect.scanning': '正在扫描…',
      'connect.found': '发现 {n} 台设备',
      'connect.scanEmpty': '没有发现设备，请手动输入地址',
      'connect.self': '本机',
      'connect.host': '地址',
      'net.portEmpty': '（空）',
      'net.portInvalid': '端口要填 {min}–{max} 之间的数字（现在是「{value}」）',
      'connect.thisMachine': '本机 {addr}',
      'connect.port': '端口',
      'connect.password': '密码',
      'connect.name': '备注名（可选）',
      'connect.connect': '连接',
      'connect.connecting': '正在连接…',
      'connect.manual': '手动连接',
      'connect.peers': '已配对设备',
      'connect.noPeers': '还没有配对设备，先扫描或手动连接一台',
      'connect.online': '在线',
      'connect.offline': '离线',
      'connect.expired': '会话过期',
      'connect.lastSeen': '最近活动',
      'connect.probe': '测速',
      'connect.disconnect': '断开',
      'connect.forget': '忘记',
      'connect.forgetConfirm': '确认忘记这台设备？',
      'connect.probeOk': '延迟 {ms} ms',
      'connect.inbound': '对方连入',
      'connect.outbound': '本机连出',
      'sync.title': '内容同步',
      'sync.desc': '选好方向与分类，一键把 DSH 的内容搬到另一台电脑',
      'sync.peer': '目标设备',
      'sync.noPeer': '先在「连接」里配对一台设备',
      'sync.direction': '方向',
      'sync.push': '推送到对端',
      'sync.pushDesc': '把本机内容发送过去，覆盖对端的同名文件',
      'sync.pull': '从对端拉取',
      'sync.pullDesc': '把对端内容搬到本机，本机原文件会先备份',
      'sync.categories': '同步内容',
      'sync.scanRemote': '预览对端清单',
      'sync.remoteSummary': '{files} 个文件 · {size}',
      'sync.excludedLine': '有 {n} 个文件没进清单（{what}）',
      'sync.excludedShow': '看看是哪些',
      'sync.excludedHide': '收起',
      'sync.excludedRest': '还有 {n} 个没列出来（只显示前 40 个）',
      'excl.secret': '凭据/密钥',
      'excl.log': '日志/临时',
      'excl.big': '超大文件',
  'excl.denied': '读不了（权限）',
  'excl.deep': '层级太深',
      'excl.other': '其他',
      'sync.start': '开始同步',
      'sync.starting': '正在启动…',
      'sync.cancel': '取消',
      'sync.done': '同步完成',
      'sync.depsHint': '对端有 {n} 个插件缺依赖，请到「诊断 → 插件依赖」补齐',
      'sync.progressUnreliable': '进度查询失败 {n} 次：同步本身在跑，但上面的数字可能不准',
      'sync.pollStale': '已经连续 {n} 次问不到任务状态，界面上的进度可能停住了（连接或服务端可能有问题）',
      'sync.resultLine': '本次同步 {files} 个文件 · {size}',
      'sync.failed': '同步失败',
      'sync.recent': '本机接收记录',
      'sync.noRecent': '还没有接收记录',
      'sync.rollback': '回滚',
      'sync.rollbackConfirm': '确认回滚？将恢复本次同步前的文件',
      'sync.rollbackDone': '已回滚',
      'sync.files': '{n} 个文件',
      'sync.metaLine': '{time} · {n} 文件 · {size}',
      'sync.size': '{size}',
      'sync.phase.queued': '排队中',
      'sync.phase.starting': '正在连接…',
      'sync.phase.hashing': '正在校验本机文件…',
      'sync.phase.preparing': '正在准备…',
      'sync.phase.uploading': '正在上传…',
      'sync.phase.downloading': '正在下载…',
      'sync.phase.applying': '正在写入…',
      'sync.phase.done': '已完成',
      'sync.phase.failed': '失败',
      'sync.phase.cancelled': '已取消',
      'phone.title': '手机通道',
      'phone.desc': '复用已有的手机远程插件，让手机连上这台 DSH',
      'phone.notInstalled': '这台电脑上没有手机通道目录。把 phone-bridge 放到 DSH 目录下，或在插件配置里指定 bridgeDir',
      'phone.running': '运行中',
      'phone.stopped': '未运行',
      'phone.port': '端口',
      'phone.pairCode': '配对码',
      'phone.publicUrl': '公网地址',
      'phone.recommended': '推荐地址',
      'phone.start': '启动',
      'phone.stop': '停止',
      'phone.hint': '手机与电脑连同一个 Wi-Fi，在手机 App 里填入上面的地址与配对码',
  'phone.portMismatch': '端口记录里是 {rec}，实际在 {got} 跑着（记录可能没写成，重启后要重新对一次）',
  'phone.portWriteWarn': '已经在 {port} 端口起来了，但端口记录没写成，下次启动可能又回到 {from}',
      'phone.paused': '已被手动暂停',
      'diag.title': '诊断',
      'diag.desc': '排查连接、目录与权限问题',
      'diag.checks': '检查项',
      'diag.env': '环境',
      'diag.logs': '运行日志',
      'diag.copyReport': '复制诊断报告',
      'diag.ok': '正常',
      'diag.warn': '注意',
      'diag.fail': '异常',
      'diag.deps': '插件依赖',
      'diag.depsDesc': '插件源码同步后，缺失的运行依赖可以在这里补齐',
      'diag.depsOk': '全部依赖已就绪',
      'diag.depsMissing': '缺依赖',
      'diag.depsInstall': '补齐',
      'diag.depsInstallAll': '全部补齐',
      'diag.depsDone': '依赖补齐完成',
      'diag.depsFail': '补齐失败：{msg}',
      'diag.depsNoNpm': '本机没找到 npm，无法自动补齐',
      'diag.depsRunning': '正在安装…',
      'diag.noLogs': '暂无日志',
      'diag.loadLogs': '加载日志',
      'toast.copied': '已复制到剪贴板',
      'toast.connectOk': '已连接',
      'toast.disconnected': '已断开',
      'toast.saved': '设置已保存',
      'toast.serverStarted': '互联服务已启动',
      'toast.serverStopped': '互联服务已停止',
      'toast.password': '密码已更换，旧连接已失效',
      'error.load': '无法读取远程互联状态',
    }

    const en = {
      nav: 'Remote Connect',
      title: 'Remote Connect',
      subtitle: 'Move DSH plugins, skills, rules, config and sessions between computers',
      'tabs.overview': 'Overview',
      'tabs.connect': 'Connect',
      'tabs.sync': 'Sync',
      'tabs.phone': 'Phone',
      'tabs.diagnostics': 'Diagnostics',
      'common.save': 'Save',
      'common.saved': 'Saved',
      'common.copy': 'Copy',
      'common.copied': 'Copied',
      'common.copyFailed': 'Copy failed — select it manually',
    'status.degraded': '{n} part(s) could not be read — these may be wrong for now:',
      'common.confirm': 'Confirm?',
      'common.cancel': 'Cancel',
      'common.refresh': 'Refresh',
      'common.retry': 'Retry',
      'common.loading': 'Loading…',
      'common.none': 'None',
      'common.show': 'Show',
      'common.hide': 'Hide',
      'common.on': 'On',
      'common.off': 'Off',
      'overview.service': 'Link service',
      'overview.running': 'Running',
      'overview.stopped': 'Stopped',
      'overview.port': 'Port',
      'overview.bind': 'Bind address',
      'overview.bindLan': '0.0.0.0 · reachable on LAN',
      'overview.bindLocal': '127.0.0.1 · this machine only',
      'overview.identity': 'This device',
      'overview.deviceName': 'Device name',
      'overview.renameHint': 'The other computer sees this name when pairing',
      'overview.addresses': 'LAN addresses',
      'overview.addressHint': 'Any of these can be typed on the other machine',
      'overview.password': 'Connection password',
      'overview.passwordHint': 'The other computer needs it to connect here',
      'overview.rotate': 'Rotate password',
      'overview.rotateConfirm': 'Rotate now? All existing sessions end',
      'overview.copyInfo': 'Copy connection info',
      'overview.uri': 'Connect string',
      'overview.uriHint': 'Paste it on the other computer to skip typing the address',
      'overview.stats': 'At a glance',
      'overview.peers': 'Paired devices',
      'overview.cats': 'Sync categories',
      'overview.lastSync': 'Last sync',
      'overview.enable': 'Enable link service',
      'overview.enableHint': 'When off, this machine accepts no incoming connections',
      'overview.discovery': 'LAN discovery',
      'overview.discoveryHint': 'Let devices on the same subnet find this machine',
      'overview.serverSection': 'Local service',
      'overview.never': 'No sync yet',
      'overview.ready': 'Ready',
      'connect.title': 'Connect another computer',
      'connect.desc': 'Enter an address and password, or scan the local network',
      'connect.scan': 'Scan network',
      'connect.scanning': 'Scanning…',
      'connect.found': 'Found {n} device(s)',
      'connect.scanEmpty': 'Nothing found — enter the address manually',
      'connect.self': 'This machine',
      'connect.host': 'Host',
      'net.portEmpty': '(empty)',
      'net.portInvalid': 'Port must be a number between {min} and {max} (got "{value}")',
      'connect.thisMachine': 'This machine {addr}',
      'connect.port': 'Port',
      'connect.password': 'Password',
      'connect.name': 'Label (optional)',
      'connect.connect': 'Connect',
      'connect.connecting': 'Connecting…',
      'connect.manual': 'Manual connection',
      'connect.peers': 'Paired devices',
      'connect.noPeers': 'No paired devices yet — scan or connect one first',
      'connect.online': 'Online',
      'connect.offline': 'Offline',
      'connect.expired': 'Session expired',
      'connect.lastSeen': 'Last seen',
      'connect.probe': 'Ping',
      'connect.disconnect': 'Disconnect',
      'connect.forget': 'Forget',
      'connect.forgetConfirm': 'Forget this device?',
      'connect.probeOk': '{ms} ms',
      'connect.inbound': 'Inbound',
      'connect.outbound': 'Outbound',
      'sync.title': 'Content sync',
      'sync.desc': 'Pick a direction and categories, then move everything in one go',
      'sync.peer': 'Target device',
      'sync.noPeer': 'Pair a device on the Connect tab first',
      'sync.direction': 'Direction',
      'sync.push': 'Push to peer',
      'sync.pushDesc': 'Send this machine’s content; same-named files on the peer are replaced',
      'sync.pull': 'Pull from peer',
      'sync.pullDesc': 'Bring the peer’s content here; local files are backed up first',
      'sync.categories': 'What to sync',
      'sync.scanRemote': 'Preview peer inventory',
      'sync.remoteSummary': '{files} files · {size}',
      'sync.excludedLine': '{n} files left out ({what})',
      'sync.excludedShow': 'Show them',
      'sync.excludedHide': 'Hide',
      'sync.excludedRest': '{n} more not listed (first 40 only)',
      'excl.secret': 'secrets',
      'excl.log': 'logs/temp',
      'excl.big': 'too large',
  'excl.denied': 'unreadable',
  'excl.deep': 'too deep',
      'excl.other': 'other',
      'sync.start': 'Start sync',
      'sync.starting': 'Starting…',
      'sync.cancel': 'Cancel',
      'sync.done': 'Sync complete',
      'sync.depsHint': '{n} plugin(s) still need dependencies — open Diagnostics → Plugin dependencies',
      'sync.progressUnreliable': 'Progress lookup failed {n} time(s): the sync is still running, but the numbers above may be stale',
      'sync.pollStale': 'Could not read the task status {n} time(s) in a row — the progress shown here may be frozen',
      'sync.resultLine': 'Synced {files} file(s) · {size}',
      'sync.failed': 'Sync failed',
      'sync.recent': 'Received on this machine',
      'sync.noRecent': 'Nothing received yet',
      'sync.rollback': 'Roll back',
      'sync.rollbackConfirm': 'Roll back? Files from before this sync are restored',
      'sync.rollbackDone': 'Rolled back',
      'sync.files': '{n} files',
      'sync.metaLine': '{time} · {n} file(s) · {size}',
      'sync.size': '{size}',
      'sync.phase.queued': 'Queued',
      'sync.phase.starting': 'Connecting…',
      'sync.phase.hashing': 'Hashing local files…',
      'sync.phase.preparing': 'Preparing…',
      'sync.phase.uploading': 'Uploading…',
      'sync.phase.downloading': 'Downloading…',
      'sync.phase.applying': 'Writing…',
      'sync.phase.done': 'Done',
      'sync.phase.failed': 'Failed',
      'sync.phase.cancelled': 'Cancelled',
      'phone.title': 'Phone bridge',
      'phone.desc': 'Reuses the existing phone plugin so a phone can drive this DSH',
      'phone.notInstalled': 'No phone-bridge directory on this machine. Drop it next to DSH, or set bridgeDir in the plugin config',
      'phone.running': 'Running',
      'phone.stopped': 'Stopped',
      'phone.port': 'Port',
      'phone.pairCode': 'Pair code',
      'phone.publicUrl': 'Public URL',
      'phone.recommended': 'Recommended',
      'phone.start': 'Start',
      'phone.stop': 'Stop',
      'phone.hint': 'Keep the phone on the same Wi-Fi and enter the address and pair code in the app',
  'phone.portMismatch': 'Recorded port is {rec}, but it is actually running on {got} (the record may not have been saved — check again after a restart)',
  'phone.portWriteWarn': 'Started on port {port}, but the port record was not saved — the next start may fall back to {from}',
      'phone.paused': 'Manually paused',
      'diag.title': 'Diagnostics',
      'diag.desc': 'Check connectivity, paths and permissions',
      'diag.checks': 'Checks',
      'diag.env': 'Environment',
      'diag.logs': 'Logs',
      'diag.copyReport': 'Copy diagnostic report',
      'diag.ok': 'OK',
      'diag.warn': 'Warning',
      'diag.fail': 'Failed',
      'diag.deps': 'Plugin dependencies',
      'diag.depsDesc': 'After plugin sources are synced, missing runtime dependencies can be installed here',
      'diag.depsOk': 'All dependencies are present',
      'diag.depsMissing': 'missing',
      'diag.depsInstall': 'Install',
      'diag.depsInstallAll': 'Install all',
      'diag.depsDone': 'Dependencies installed',
      'diag.depsFail': 'Install failed: {msg}',
      'diag.depsNoNpm': 'npm was not found on this machine',
      'diag.depsRunning': 'Installing…',
      'diag.noLogs': 'No log entries',
      'diag.loadLogs': 'Load logs',
      'toast.copied': 'Copied to clipboard',
      'toast.connectOk': 'Connected',
      'toast.disconnected': 'Disconnected',
      'toast.saved': 'Settings saved',
      'toast.serverStarted': 'Link service started',
      'toast.serverStopped': 'Link service stopped',
      'toast.password': 'Password rotated; old sessions ended',
      'error.load': 'Cannot read Remote Connect status',
    }

    /* ------------------------------------------------------------------ */
    /* styles                                                             */
    /* ------------------------------------------------------------------ */

    const css = `
.dlk-root{display:flex;flex-direction:column;gap:14px;max-width:760px;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
.dlk-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.dlk-title{margin:0;font-size:18px;font-weight:600;letter-spacing:-.01em}
.dlk-sub{margin:3px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dlk-tabs{display:flex;gap:22px;border-bottom:.5px solid var(--dsw-alias-border-l2);margin-top:2px}
.dlk-tab{appearance:none;background:none;border:0;padding:7px 1px 9px;font:inherit;font-size:13px;color:var(--dsw-alias-label-tertiary);cursor:pointer;position:relative;white-space:nowrap}
.dlk-tab[data-active=true]{color:var(--dsw-alias-label-primary)}
.dlk-tab[data-active=true]:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-label-primary)}
.dlk-tab:hover{color:var(--dsw-alias-label-primary)}
.dlk-panel{display:flex;flex-direction:column;gap:12px;min-width:0;padding-top:2px}
.dlk-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);padding:14px 16px;display:flex;flex-direction:column;gap:10px;min-width:0}
.dlk-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.dlk-card-title{margin:0;font-size:14px;font-weight:600}
.dlk-card-desc{margin:2px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dlk-hint{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dlk-row{display:flex;align-items:center;gap:10px;min-width:0}
.dlk-col{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}
.dlk-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;word-break:break-all;color:var(--dsw-alias-label-secondary)}
.dlk-pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:2px 9px;font-size:11px;line-height:18px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dlk-pill[data-tone=ok]{color:var(--dsw-alias-state-success-primary,#3fb950);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#3fb950) 40%,transparent)}
.dlk-pill[data-tone=warn]{color:var(--dsw-alias-state-warning-primary,#d29922);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d29922) 40%,transparent)}
.dlk-pill[data-tone=err]{color:var(--dsw-alias-state-error-primary,#f85149);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f85149) 40%,transparent)}
.dlk-dot{width:7px;height:7px;border-radius:50%;background:currentColor;display:inline-block;flex:0 0 auto;box-shadow:0 0 6px currentColor}
.dlk-btn{appearance:none;font:inherit;font-size:12px;line-height:18px;padding:5px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;transition:background .12s ease,border-color .12s ease}
.dlk-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dlk-btn:disabled{opacity:.5;cursor:default}
.dlk-btn[data-variant=primary]{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-2,#0d1117);border-color:transparent;font-weight:600}
.dlk-btn[data-variant=primary]:hover:not(:disabled){background:var(--dsw-alias-label-primary);opacity:.9}
.dlk-btn[data-variant=danger]{color:var(--dsw-alias-state-error-primary,#f85149);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f85149) 45%,transparent)}
.dlk-btn[data-size=sm]{padding:3px 8px;font-size:11px}
.dlk-input{appearance:none;font:inherit;font-size:12px;line-height:20px;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);width:100%;min-width:0;outline:none}
.dlk-input:focus{border-color:var(--dsw-alias-label-tertiary)}
/* 键盘焦点必须看得见：宿主页面常把全局 outline 关掉，我们自己给一圈硬描边。
   :focus-visible 只在键盘/辅助技术触发时出现，鼠标点击不会闪一下。 */
.dlk-btn:focus-visible,.dlk-tab:focus-visible,.dlk-input:focus-visible,.dlk-switch:focus-visible,.dlk-check:focus-visible,.dlk-block:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}
.dlk-tab:focus-visible{outline-offset:-2px}
/* 有人把系统的「减少动态效果」打开时，别让这些过渡继续动。 */
@media (prefers-reduced-motion: reduce){.dlk-btn,.dlk-switch,.dlk-knob,.dlk-toast{transition:none}}
.dlk-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dlk-field{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 140px}
.dlk-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dlk-grid{display:flex;gap:10px;flex-wrap:wrap;min-width:0}
.dlk-switch{appearance:none;width:34px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;position:relative;cursor:pointer;flex:0 0 auto;transition:background .15s ease}
.dlk-switch[data-on=true]{background:var(--dsw-alias-label-primary);border-color:transparent}
.dlk-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:transform .15s ease,background .15s ease}
.dlk-switch[data-on=true] .dlk-knob{transform:translateX(14px);background:var(--dsw-alias-bg-layer-2,#fff)}
.dlk-check{appearance:none;width:16px;height:16px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2);background:transparent;cursor:pointer;flex:0 0 auto;position:relative}
.dlk-check[data-on=true]{background:var(--dsw-alias-label-primary);border-color:transparent}
.dlk-check[data-on=true]:after{content:"";position:absolute;left:5px;top:1.5px;width:4px;height:8px;border:solid var(--dsw-alias-bg-layer-2,#fff);border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}
.dlk-block{display:flex;gap:10px;align-items:flex-start;padding:9px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);cursor:pointer;min-width:0;background:transparent;text-align:left;font:inherit;color:inherit}
.dlk-block[data-on=true]{border-color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover)}
.dlk-group{display:flex;flex-direction:column;gap:8px;min-width:0}
.dlk-divide{height:1px;background:var(--dsw-alias-border-l2);margin:2px 0}
.dlk-empty{padding:16px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dlk-degraded{margin:0 0 12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-label-warning,#c98a00);border-radius:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dlk-degraded ul{margin:6px 0 0;padding-left:18px;color:var(--dsw-alias-label-tertiary)}
.dlk-bar{height:6px;border-radius:999px;background:var(--dsw-alias-border-l2);overflow:hidden}
.dlk-bar>i{display:block;height:100%;background:var(--dsw-alias-label-primary);transition:width .3s ease}
.dlk-toast{position:sticky;bottom:0;align-self:flex-start;padding:6px 11px;border-radius:8px;font-size:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);box-shadow:0 4px 16px rgba(0,0,0,.12)}
.dlk-toast[data-tone=error]{color:var(--dsw-alias-state-error-primary,#f85149);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f85149) 45%,transparent)}
.dlk-toast[data-tone=ok]{color:var(--dsw-alias-state-success-primary,#3fb950)}
.dlk-toast[data-tone=warn]{color:var(--dsw-alias-state-warning-primary,#d29922);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d29922) 45%,transparent)}
.dlk-spin{width:14px;height:14px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-primary);animation:dlk-rot .8s linear infinite;display:inline-block}
@keyframes dlk-rot{to{transform:rotate(360deg)}}
.dlk-scroll{max-height:280px;overflow:auto;display:flex;flex-direction:column;gap:6px;padding-right:2px}
.dlk-log{max-height:240px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-secondary)}
.dlk-kv{display:flex;gap:10px;font-size:12px;min-width:0}
.dlk-kv>span:first-child{flex:0 0 92px;color:var(--dsw-alias-label-tertiary)}
.dlk-kv>span:last-child{flex:1 1 auto;min-width:0;word-break:break-all;color:var(--dsw-alias-label-secondary)}
.dlk-iconbtn{appearance:none;background:none;border:0;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:2px;display:inline-flex;border-radius:6px}
.dlk-iconbtn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
`

    if (typeof document !== 'undefined') {
      const tagId = 'dsh-remote-connect/remote-connect.css'
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-remote-connect'
        tag.dataset.pluginCss = tagId
        tag.textContent = css
        document.head.appendChild(tag)
      }
    }

    /* ------------------------------------------------------------------ */
    /* api / utils                                                        */
    /* ------------------------------------------------------------------ */

    async function api(path, method, body) {
      const m = method || 'GET'
      const res = await fetch(API + path, {
        method: m,
        headers: m === 'GET' ? undefined : { 'content-type': 'application/json' },
        body: m === 'GET' ? undefined : JSON.stringify(body || {}),
      })
      let json = null
      try {
        json = await res.json()
      } catch {
        throw new Error('HTTP ' + res.status)
      }
      if (!json || json.ok !== true) {
        const err = new Error((json && json.error && json.error.message) || 'HTTP ' + res.status)
        err.code = json && json.error && json.error.code
        throw err
      }
      return json.data
    }

    function fmtBytes(n) {
      const v = Number(n) || 0
      if (v < 1024) return v + ' B'
      const units = ['KB', 'MB', 'GB', 'TB']
      let x = v / 1024
      let i = 0
      while (x >= 1024 && i < units.length - 1) {
        x /= 1024
        i += 1
      }
      return (x >= 10 ? x.toFixed(0) : x.toFixed(1)) + ' ' + units[i]
    }

    /**
     * 端口按字面读：'abc'、''、'0'、'70000' 都不能悄悄变成默认值。
     * 以前写的是 `Number(port) || 8788`，用户填错之后界面还是会说「已保存」——
     * 他以为自己改成了 A，实际保存的是默认端口。
     */
    function parsePort(raw, { min = 1024, max = 65535 } = {}) {
      const text = String(raw ?? '').trim()
      if (!/^\d{1,5}$/.test(text)) return { ok: false, text }
      const value = Number(text)
      if (!Number.isInteger(value) || value < min || value > max) return { ok: false, text }
      return { ok: true, value, text }
    }

    function timeText(ts) {
      if (!ts) return '—'
      try {
        return new Date(ts).toLocaleString()
      } catch {
        return String(ts)
      }
    }

    function pct(done, total) {
      if (!total) return 0
      return Math.max(0, Math.min(100, Math.round((Number(done) / Number(total)) * 100)))
    }

    async function copyText(text) {
      const value = String(text == null ? '' : text)
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(value)
          return true
        }
      } catch {
        /* fall through */
      }
      try {
        const el = document.createElement('textarea')
        el.value = value
        el.style.position = 'fixed'
        el.style.opacity = '0'
        document.body.appendChild(el)
        el.select()
        document.execCommand('copy')
        document.body.removeChild(el)
        return true
      } catch {
        return false
      }
    }

    /* ------------------------------------------------------------------ */
    /* primitives                                                         */
    /* ------------------------------------------------------------------ */

    const Ctx = createContext(null)
    const useCtx = () => useContext(Ctx)

    function Spinner() {
      // 转圈本身不传达信息，给读屏器留出「加载中」的文字
      return h('span', { className: 'dlk-spin', 'aria-hidden': 'true' })
    }

    function Btn({ children, onClick, variant, size, disabled, busy, title, type, ...rest }) {
      return h(
        'button',
        {
          // rest 里是调用方传的其它属性（onKeyDown、aria-live、data-* …）。
          // 以前这里把它们全丢了：ConfirmBtn 传的 onKeyDown 根本没挂到按钮上。
          ...rest,
          type: type || 'button',
          className: 'dlk-btn',
          'data-variant': variant,
          'data-size': size,
          title,
          disabled: disabled || busy,
          'aria-busy': busy ? 'true' : undefined,
          onClick,
        },
        busy ? h(Spinner) : null,
        children,
      )
    }

    function ConfirmBtn({ label, confirmLabel, onConfirm, variant, size, disabled, t }) {
      const [arming, setArming] = useState(false)
      useEffect(() => {
        if (!arming) return undefined
        const id = setTimeout(() => setArming(false), 3500)
        return () => clearTimeout(id)
      }, [arming])
      return h(
        Btn,
        {
          variant: arming ? 'danger' : variant,
          size,
          disabled,
          // 已经举起来的那只手，键盘用户也得能放下：Esc 撤防，不用等 3.5 秒。
          onKeyDown: (e) => {
            if (e.key === 'Escape' && arming) {
              e.preventDefault()
              setArming(false)
            }
          },
          'aria-live': arming ? 'polite' : undefined,
          onClick: () => {
            if (!arming) {
              setArming(true)
              return
            }
            setArming(false)
            onConfirm()
          },
        },
        arming ? confirmLabel || t('common.confirm') : label,
      )
    }

    function CopyBtn({ text, label, t, size }) {
      // idle / done / fail：复制失败也要说一声，
      // 否则用户点了「复制」什么都没发生，只会以为按钮坏了。
      const [state, setState] = useState('idle')
      const flash = (next) => {
        setState(next)
        setTimeout(() => setState('idle'), 1800)
      }
      return h(
        Btn,
        {
          size,
          title: state === 'fail' ? t('common.copyFailed') : undefined,
          onClick: async () => {
            const ok = await copyText(text)
            flash(ok ? 'done' : 'fail')
          },
        },
        state === 'done'
          ? '✓ ' + t('common.copied')
          : state === 'fail'
            ? '✗ ' + t('common.copyFailed')
            : label || t('common.copy'),
      )
    }

    function Pill({ tone, children }) {
      return h('span', { className: 'dlk-pill', 'data-tone': tone }, h('span', { className: 'dlk-dot', 'aria-hidden': 'true' }), children)
    }

    function Card({ title, desc, right, children }) {
      return h(
        'section',
        { className: 'dlk-card' },
        title || right
          ? h(
              'div',
              { className: 'dlk-card-head' },
              h('div', { className: 'dlk-col' }, h('h3', { className: 'dlk-card-title' }, title), desc ? h('p', { className: 'dlk-card-desc' }, desc) : null),
              right || null,
            )
          : null,
        children,
      )
    }

    function Field({ label, children, flex }) {
      return h('label', { className: 'dlk-field', style: flex ? { flex } : undefined }, h('span', { className: 'dlk-label' }, label), children)
    }

    function Input(props) {
      return h('input', { ...props, className: 'dlk-input' })
    }

    function Toggle({ checked, onChange, label, desc, disabled }) {
      return h(
        'div',
        { className: 'dlk-row' },
        h('div', { className: 'dlk-col' }, h('span', { className: 'dlk-label' }, label), desc ? h('span', { className: 'dlk-hint' }, desc) : null),
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': Boolean(checked),
          className: 'dlk-switch',
          'data-on': Boolean(checked),
          disabled,
          onClick: () => !disabled && onChange(!checked),
        }, h('span', { className: 'dlk-knob' })),
      )
    }

    function Check({ checked, onChange, label, desc }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'checkbox',
          'aria-checked': Boolean(checked),
          className: 'dlk-block',
          'data-on': Boolean(checked),
          onClick: () => onChange(!checked),
        },
        h('span', { className: 'dlk-check', 'data-on': Boolean(checked), 'aria-hidden': 'true' }),
        h('span', { className: 'dlk-col' }, h('span', { className: 'dlk-label', style: { color: 'inherit' } }, label), desc ? h('span', { className: 'dlk-hint' }, desc) : null),
      )
    }

    function KV({ k, children }) {
      return h('div', { className: 'dlk-kv' }, h('span', null, k), h('span', null, children))
    }

    /* ------------------------------------------------------------------ */
    /* context / shell                                                    */
    /* ------------------------------------------------------------------ */

    function useToast() {
      const [toast, setToast] = useState(null)
      const timer = useRef(null)
      // 上一次已经念过的内容：内容没变就不再让读屏软件重念一遍
      const spoken = useRef('')
      const notify = useCallback((message, tone) => {
        const text = String(message ?? '')
        if (!text) return
        const nextTone = tone || 'ok'
        const signature = nextTone + '|' + text
        const repeat = signature === spoken.current
        spoken.current = signature
        setToast({ message: text, tone: nextTone, id: Math.random(), repeat })
        clearTimeout(timer.current)
        // 错误多留一会儿：它是唯一需要人动手处理的那类提示
        timer.current = setTimeout(() => setToast(null), nextTone === 'error' ? 9000 : 4200)
      }, [])
      useEffect(() => () => clearTimeout(timer.current), [])
      return { toast, notify }
    }

    function RemoteConnectSection(props) {
      const t = props && props.t ? props.t : (k) => k
      const [tab, setTab] = useState('overview')
      const [status, setStatus] = useState(null)
      const [loadError, setLoadError] = useState(null)
      const { toast, notify } = useToast()

      const reload = useCallback(async (quiet) => {
        try {
          const data = await api('/status')
          setStatus(data)
          setLoadError(null)
          return data
        } catch (e) {
          if (!quiet) setLoadError(e.message)
          return null
        }
      }, [])

      useEffect(() => {
        reload(false)
        const id = setInterval(() => {
          if (typeof document === 'undefined' || document.visibilityState !== 'hidden') reload(true)
        }, 4000)
        return () => clearInterval(id)
      }, [reload])

      const ctx = useMemo(() => ({ t, status, reload, notify }), [t, status, reload, notify])

      const tabs = [
        ['overview', t('tabs.overview')],
        ['connect', t('tabs.connect')],
        ['sync', t('tabs.sync')],
        ['phone', t('tabs.phone')],
        ['diagnostics', t('tabs.diagnostics')],
      ]

      // 标签栏按 ARIA 的 tabs 模式走：只有当前标签在 Tab 序列里，左右键/Home/End 切换
      const tabRefs = useRef({})
      const onTabKey = (event) => {
        const ids = tabs.map(([id]) => id)
        const at = ids.indexOf(tab)
        let next = null
        if (event.key === 'ArrowRight') next = ids[(at + 1) % ids.length]
        else if (event.key === 'ArrowLeft') next = ids[(at - 1 + ids.length) % ids.length]
        else if (event.key === 'Home') next = ids[0]
        else if (event.key === 'End') next = ids[ids.length - 1]
        if (!next) return
        event.preventDefault()
        go(next)
        const el = tabRefs.current[next]
        if (el && typeof el.focus === 'function') el.focus()
      }

      const go = (id) => {
        setTab(id)
        api('/config', 'POST', { ui: { lastTab: id } }).catch(() => {})
      }

      return h(
        Ctx.Provider,
        { value: ctx },
        h(
          'div',
          { className: 'dlk-root' },
          h(
            'div',
            { className: 'dlk-head' },
            h(
              'div',
              null,
              h('h2', { className: 'dlk-title' }, t('title')),
              h('p', { className: 'dlk-sub' }, t('subtitle')),
            ),
            status
              ? h(
                  Pill,
                  { tone: status.server && status.server.running ? 'ok' : 'warn' },
                  (status.server && status.server.running ? t('overview.running') : t('overview.stopped')) +
                    (status.server && status.server.port ? ' · ' + status.server.port : ''),
                )
              : null,
          ),
          h(
            'div',
            { className: 'dlk-tabs', role: 'tablist', 'aria-label': t('title'), onKeyDown: onTabKey },
            tabs.map(([id, label]) =>
              h(
                'button',
                {
                  key: id,
                  type: 'button',
                  role: 'tab',
                  id: 'dlk-tab-' + id,
                  'aria-selected': tab === id,
                  'aria-controls': 'dlk-panel-' + id,
                  tabIndex: tab === id ? 0 : -1,
                  className: 'dlk-tab',
                  'data-active': tab === id,
                  ref: (el) => {
                    tabRefs.current[id] = el
                  },
                  onClick: () => go(id),
                },
                label,
              ),
            ),
          ),
          status && Array.isArray(status.degraded) && status.degraded.length > 0
            ? h(
                'div',
                { className: 'dlk-degraded', role: 'alert' },
                t('status.degraded').replace('{n}', String(status.degraded.length)),
                h(
                  'ul',
                  null,
                  status.degraded.map((d) =>
                    h('li', { key: d.section }, d.section + '：' + (d.error || d.code || '')),
                  ),
                ),
              )
            : null,
          !status && !loadError
            ? h('div', { className: 'dlk-empty', role: 'status' }, h(Spinner), ' ', t('common.loading'))
            : loadError && !status
              ? h(
                  'div',
                  { className: 'dlk-empty', role: 'alert' },
                  t('error.load') + '：' + loadError,
                  h('div', { style: { marginTop: 8 } }, h(Btn, { onClick: () => reload(false) }, t('common.retry'))),
                )
              : h(
                  'div',
                  {
                    className: 'dlk-panel',
                    role: 'tabpanel',
                    id: 'dlk-panel-' + tab,
                    'aria-labelledby': 'dlk-tab-' + tab,
                    tabIndex: 0,
                  },
                  tab === 'overview' ? h(OverviewPage) : null,
                  tab === 'connect' ? h(ConnectPage) : null,
                  tab === 'sync' ? h(SyncPage) : null,
                  tab === 'phone' ? h(PhonePage) : null,
                  tab === 'diagnostics' ? h(DiagnosticsPage) : null,
                ),
          toast
            ? h(
                'div',
                {
                  className: 'dlk-toast',
                  'data-tone': toast.tone,
                  role: 'status',
                  // 同样的内容再念一遍只是噪音：连续两次同文（比如连点两下）时改成 off，
                  // 对话框本身已经写着字，视觉上照样看得到。
                  'aria-live': toast.repeat ? 'off' : toast.tone === 'error' ? 'assertive' : 'polite',
                },
                toast.message,
              )
            : null,
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* overview                                                           */
    /* ------------------------------------------------------------------ */

    function OverviewPage() {
      const { t, status, reload, notify } = useCtx()
      const cfg = status.config
      const server = status.server
      const [name, setName] = useState(cfg.device.name)
      const [reveal, setReveal] = useState(false)
      const [busy, setBusy] = useState('')

      useEffect(() => setName(cfg.device.name), [cfg.device.name])

      const act = async (key, fn, okMsg) => {
        setBusy(key)
        try {
          await fn()
          await reload(true)
          if (okMsg) notify(okMsg)
        } catch (e) {
          notify(e.message, 'error')
        } finally {
          setBusy('')
        }
      }

      const saveName = () => {
        const v = name.trim()
        if (!v || v === cfg.device.name) return
        act('name', () => api('/device/name', 'POST', { name: v }), t('common.saved'))
      }

      const running = Boolean(server && server.running)
      const connectedPeers = (status.peers || []).filter((p) => p.connected).length
      const enabledCats = Object.keys(cfg.sync.categories || {}).filter((k) => cfg.sync.categories[k])
      const recent = (status.recent || [])[0]

      return h(
        React.Fragment,
        null,
        h(
          Card,
          {
            title: t('overview.serverSection'),
            desc: running ? t('overview.ready') : t('overview.stopped'),
            right: h(
              Btn,
              {
                variant: running ? 'default' : 'primary',
                busy: busy === 'server',
                onClick: () =>
                  act('server', () => api(running ? '/server/stop' : '/server/start', 'POST'), running ? t('toast.serverStopped') : t('toast.serverStarted')),
              },
              running ? t('overview.stopped') : t('overview.running'),
            ),
          },
          h(KV, { k: t('overview.port') }, server && server.port ? String(server.port) : '—'),
          h(KV, { k: t('overview.deviceName') }, String(cfg.device.id || '').slice(0, 12)),
          h(
            'div',
            { className: 'dlk-grid', style: { marginTop: 2 } },
            h(
              'div',
              { className: 'dlk-field', style: { flex: '1 1 240px' } },
              h('span', { className: 'dlk-label' }, t('overview.deviceName')),
              h('div', { className: 'dlk-row' },
                h(Input, {
                  value: name,
                  maxLength: 48,
                  onChange: (e) => setName(e.target.value),
                  onBlur: saveName,
                  onKeyDown: (e) => { if (e.key === 'Enter') e.currentTarget.blur() },
                }),
                h(Btn, { size: 'sm', busy: busy === 'name', onClick: saveName }, t('common.save')),
              ),
              h('span', { className: 'dlk-hint' }, t('overview.renameHint')),
            ),
          ),
        ),
        h(
          Card,
          { title: t('overview.addresses'), desc: t('overview.addressHint') },
          (cfg.server.addresses || []).length === 0
            ? h('div', { className: 'dlk-hint' }, '—')
            : (cfg.server.addresses || []).map((a) =>
                h(
                  'div',
                  { className: 'dlk-row', key: a.iface + a.address },
                  h('span', { className: 'dlk-mono', style: { flex: '1 1 auto' } }, a.address + ':' + cfg.server.port),
                  h('span', { className: 'dlk-hint' }, a.iface),
                  h(CopyBtn, { size: 'sm', text: a.address + ':' + cfg.server.port, t }),
                ),
              ),
        ),
        h(
          Card,
          {
            title: t('overview.password'),
            desc: t('overview.passwordHint'),
            right: h(
              ConfirmBtn,
              {
                t,
                label: t('overview.rotate'),
                confirmLabel: t('overview.rotateConfirm'),
                busy: busy === 'rotate',
                onConfirm: () => act('rotate', () => api('/password/rotate', 'POST'), t('toast.password')),
              },
            ),
          },
          h(
            'div',
            { className: 'dlk-row' },
            h('span', { className: 'dlk-mono', style: { flex: '1 1 auto', fontSize: 14, letterSpacing: '.08em' } },
              reveal ? cfg.auth.password : '•'.repeat(Math.min(24, String(cfg.auth.password || '').length || 12))),
            h(Btn, { size: 'sm', onClick: () => setReveal((v) => !v) }, reveal ? t('common.hide') : t('common.show')),
            h(CopyBtn, { size: 'sm', text: cfg.auth.password, t }),
          ),
          h('div', { className: 'dlk-divide' }),
          h(KV, { k: t('overview.uri') },
            h('span', { className: 'dlk-mono' }, reveal ? cfg.connectUri : String(cfg.connectUri || '').replace(/pwd=[^&]*/, 'pwd=••••••')),
          ),
          h('div', { className: 'dlk-row' },
            h(CopyBtn, { size: 'sm', text: cfg.connectUri, label: t('overview.copyInfo'), t }),
            h('span', { className: 'dlk-hint' }, t('overview.uriHint')),
          ),
        ),
        h(
          Card,
          { title: t('overview.stats') },
          h(KV, { k: t('overview.peers') }, connectedPeers + ' / ' + (status.peers || []).length),
          h(KV, { k: t('overview.cats') }, String(enabledCats.length)),
          h(KV, { k: t('overview.lastSync') }, recent ? timeText(recent.finishedAt || recent.at || recent.startedAt) : t('overview.never')),
        ),
        h(
          Card,
          { title: t('common.on') + ' / ' + t('common.off') },
          h(Toggle, {
            checked: Boolean(cfg.server.enabled),
            disabled: busy === 'enabled',
            label: t('overview.enable'),
            desc: t('overview.enableHint'),
            onChange: (v) => act('enabled', () => api('/config', 'POST', { server: { enabled: v } }), t('toast.saved')),
          }),
          h(Toggle, {
            checked: Boolean(cfg.server.discovery),
            disabled: busy === 'discovery',
            label: t('overview.discovery'),
            desc: t('overview.discoveryHint'),
            onChange: (v) => act('discovery', () => api('/config', 'POST', { server: { discovery: v } }), t('toast.saved')),
          }),
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* connect                                                            */
    /* ------------------------------------------------------------------ */

    function ConnectPage() {
      const { t, status, reload, notify } = useCtx()
      const cfg = status.config
      const [port, setPort] = useState(String(cfg.server.port))
      const [bind, setBind] = useState(cfg.server.bind)
      const [discovery, setDiscovery] = useState(Boolean(cfg.server.discovery))
      const [saving, setSaving] = useState(false)
      const [found, setFound] = useState(null)
      const [scanning, setScanning] = useState(false)
      const [form, setForm] = useState({ host: '', port: '8788', password: '', name: '' })
      const [connecting, setConnecting] = useState(false)
      const [probe, setProbe] = useState({})
      const [busyPeer, setBusyPeer] = useState('')

      const saveServer = async () => {
        const parsed = parsePort(port, { min: 1024, max: 65535 })
        if (!parsed.ok) {
          return notify(t('net.portInvalid', { value: parsed.text || t('net.portEmpty'), min: 1024, max: 65535 }), 'error')
        }
        setSaving(true)
        try {
          await api('/config', 'POST', {
            server: { port: parsed.value, bind, discovery, enabled: cfg.server.enabled },
          })
          await reload(true)
          notify(t('toast.saved'))
        } catch (e) {
          notify(e.message, 'error')
        } finally {
          setSaving(false)
        }
      }

      const scan = async () => {
        setScanning(true)
        setFound(null)
        try {
          const rows = await api('/discover', 'POST', { timeoutMs: 2200 })
          setFound(rows || [])
          if (!rows || !rows.length) notify(t('connect.scanEmpty'), 'error')
        } catch (e) {
          notify(e.message, 'error')
          setFound([])
        } finally {
          setScanning(false)
        }
      }

      const connect = async (override) => {
        if (override) {
          // 从扫描结果里点进来的：端口是探测出来的数字，仍然按同一套规则核一遍
          const parsed = parsePort(override.port, { min: 1, max: 65535 })
          if (!parsed.ok) {
            return notify(t('net.portInvalid', { value: parsed.text || t('net.portEmpty'), min: 1, max: 65535 }), 'error')
          }
          return runConnect({ ...override, port: parsed.value })
        }
        const host = form.host.trim()
        if (!host) return notify(t('connect.host'), 'error')
        const parsed = parsePort(form.port, { min: 1, max: 65535 })
        if (!parsed.ok) {
          return notify(t('net.portInvalid', { value: parsed.text || t('net.portEmpty'), min: 1, max: 65535 }), 'error')
        }
        return runConnect({
          host,
          port: parsed.value,
          password: form.password,
          name: form.name.trim() || undefined,
        })
      }

      const runConnect = async (payload) => {
        setConnecting(true)
        try {
          await api('/connect', 'POST', payload)
          setForm((f) => ({ ...f, password: '' }))
          await reload(true)
          notify(t('toast.connectOk'))
        } catch (e) {
          notify(e.message, 'error')
        } finally {
          setConnecting(false)
        }
      }

      const peerAct = async (id, kind) => {
        setBusyPeer(id + ':' + kind)
        try {
          if (kind === 'probe') {
            const r = await api('/peer/probe', 'POST', { id })
            setProbe((p) => ({ ...p, [id]: r }))
          } else if (kind === 'disconnect') {
            await api('/peer/disconnect', 'POST', { id })
            notify(t('toast.disconnected'))
          } else if (kind === 'forget') {
            await api('/peer/forget', 'POST', { id })
            notify(t('toast.disconnected'))
          }
          await reload(true)
        } catch (e) {
          notify(e.message, 'error')
        } finally {
          setBusyPeer('')
        }
      }

      return h(
        React.Fragment,
        null,
        h(
          Card,
          { title: t('connect.title'), desc: t('connect.desc'), right: h(Btn, { onClick: scan, busy: scanning }, scanning ? t('connect.scanning') : t('connect.scan')) },
          found === null
            ? null
            : found.length === 0
              ? h('div', { className: 'dlk-empty' }, t('connect.scanEmpty'))
              : h(
                  'div',
                  { className: 'dlk-group' },
                  found.map((d) =>
                    h(
                      'div',
                      { className: 'dlk-row', key: d.id + d.host, style: { padding: '6px 8px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 9 } },
                      h(Pill, { tone: d.self ? 'warn' : 'ok' }, d.self ? t('connect.self') : t('connect.online')),
                      h('div', { className: 'dlk-col' },
                        h('span', { className: 'dlk-label', style: { color: 'inherit' } }, d.name || d.host),
                        h('span', { className: 'dlk-hint' }, d.host + ':' + d.port + (d.platform ? ' · ' + d.platform : '')),
                      ),
                      d.self
                        ? null
                        : h(Btn, { size: 'sm', variant: 'primary', onClick: () => connect({ host: d.host, port: d.port }) }, t('connect.connect')),
                    ),
                  ),
                ),
          h('div', { className: 'dlk-divide' }),
          h('span', { className: 'dlk-label' }, t('connect.manual')),
          h(
            'div',
            { className: 'dlk-grid' },
            h(Field, { label: t('connect.host'), flex: '2 1 180px' }, h(Input, { value: form.host, placeholder: '192.168.1.20', onChange: (e) => setForm({ ...form, host: e.target.value }) })),
            h(Field, { label: t('connect.port'), flex: '1 1 80px' }, h(Input, { value: form.port, inputMode: 'numeric', onChange: (e) => setForm({ ...form, port: e.target.value }) })),
          ),
          h(
            'div',
            { className: 'dlk-grid' },
            h(Field, { label: t('connect.password'), flex: '2 1 180px' }, h(Input, { value: form.password, type: 'password', autoComplete: 'off', onChange: (e) => setForm({ ...form, password: e.target.value }), onKeyDown: (e) => { if (e.key === 'Enter') connect() } })),
            h(Field, { label: t('connect.name'), flex: '1 1 120px' }, h(Input, { value: form.name, onChange: (e) => setForm({ ...form, name: e.target.value }) })),
          ),
          h('div', { className: 'dlk-row' },
            h(Btn, { variant: 'primary', busy: connecting, onClick: () => connect() }, connecting ? t('connect.connecting') : t('connect.connect')),
            h('span', { className: 'dlk-hint' }, cfg.server.addresses && cfg.server.addresses[0] ? t('connect.thisMachine').replace('{addr}', cfg.server.addresses[0].address + ':' + cfg.server.port) : ''),
          ),
        ),
        h(
          Card,
          { title: t('overview.serverSection') },
          h(
            'div',
            { className: 'dlk-grid' },
            h(Field, { label: t('overview.port'), flex: '1 1 90px' }, h(Input, { value: port, inputMode: 'numeric', onChange: (e) => setPort(e.target.value) })),
            h(
              Field,
              { label: t('overview.bind'), flex: '1 1 140px' },
              h(
                'select',
                { className: 'dlk-input', value: bind, onChange: (e) => setBind(e.target.value) },
                h('option', { value: '0.0.0.0' }, t('overview.bindLan')),
                h('option', { value: '127.0.0.1' }, t('overview.bindLocal')),
              ),
            ),
          ),
          h(Toggle, { checked: discovery, onChange: setDiscovery, label: t('overview.discovery'), desc: t('overview.discoveryHint') }),
          h('div', { className: 'dlk-row' }, h(Btn, { busy: saving, onClick: saveServer }, t('common.save'))),
        ),
        h(
          Card,
          { title: t('connect.peers') },
          (status.peers || []).length === 0
            ? h('div', { className: 'dlk-empty' }, t('connect.noPeers'))
            : h(
                'div',
                { className: 'dlk-group' },
                (status.peers || []).map((p) =>
                  h(
                    'div',
                    { className: 'dlk-row', key: p.id, style: { padding: '7px 9px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 9 } },
                    h(Pill, { tone: p.connected ? 'ok' : p.lastError ? 'err' : 'warn' }, p.connected ? t('connect.online') : t('connect.offline')),
                    h(
                      'div',
                      { className: 'dlk-col' },
                      h('span', { className: 'dlk-label', style: { color: 'inherit' } }, p.name || p.host),
                      h('span', { className: 'dlk-hint' },
                        p.host + ':' + p.port +
                        (p.direction === 'inbound' ? ' · ' + t('connect.inbound') : '') +
                        (probe[p.id] && probe[p.id].ok ? ' · ' + t('connect.probeOk').replace('{ms}', probe[p.id].ms) : '') +
                        (probe[p.id] && !probe[p.id].ok ? ' · ' + probe[p.id].error : '')),
                    ),
                    h(Btn, { size: 'sm', busy: busyPeer === p.id + ':probe', onClick: () => peerAct(p.id, 'probe') }, t('connect.probe')),
                    p.connected ? h(Btn, { size: 'sm', busy: busyPeer === p.id + ':disconnect', onClick: () => peerAct(p.id, 'disconnect') }, t('connect.disconnect')) : null,
                    h(ConfirmBtn, { t, size: 'sm', variant: 'danger', label: t('connect.forget'), confirmLabel: t('connect.forgetConfirm'), busy: busyPeer === p.id + ':forget', onConfirm: () => peerAct(p.id, 'forget') }),
                  ),
                ),
              ),
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* sync                                                               */
    /* ------------------------------------------------------------------ */

    function SyncPage() {
      const { t, status, reload, notify } = useCtx()
      const cfg = status.config
      const peers = status.peers || []
      const [peerId, setPeerId] = useState(peers[0] ? peers[0].id : '')
      const [direction, setDirection] = useState('push')
      const [cats, setCats] = useState(() => ({ ...cfg.sync.categories }))
      const [remote, setRemote] = useState(null)
      // 被跳过的文件明细：默认收起，别把页面撑长；想查具体是哪些再展开
      const [showExcluded, setShowExcluded] = useState(false)
      const [scanning, setScanning] = useState(false)
      const [starting, setStarting] = useState(false)
      const [task, setTask] = useState(null)
      const [depsMissing, setDepsMissing] = useState(0)
      // 连续问不到任务状态的次数：问不到时界面上的进度是冻住的，
      // 以前这里只有一句「keep polling」，用户看到的就是一条不动的进度条。
      const [pollFails, setPollFails] = useState(0)

      useEffect(() => {
        if (!peerId && peers[0]) setPeerId(peers[0].id)
      }, [peers.length, peerId])

      const selectedCats = Object.keys(cats).filter((k) => cats[k])

      const scanRemote = async () => {
        if (!peerId) return notify(t('sync.noPeer'), 'error')
        setScanning(true)
        try {
          const inv = await api('/inventory', 'POST', { peerId, cats: selectedCats })
          setRemote(inv)
          notify(t('sync.remoteSummary').replace('{files}', inv.totalFiles).replace('{size}', fmtBytes(inv.totalBytes)))
        } catch (e) {
          notify(e.message, 'error')
        } finally {
          setScanning(false)
        }
      }

      const start = async () => {
        if (!peerId) return notify(t('sync.noPeer'), 'error')
        if (!selectedCats.length) return notify(t('sync.categories'), 'error')
        setStarting(true)
        try {
          const created = await api('/sync', 'POST', { peerId, direction, cats: selectedCats })
          setTask(created)
        } catch (e) {
          notify(e.message, 'error')
        } finally {
          setStarting(false)
        }
      }

      useEffect(() => {
        if (!task || task.phase === 'done' || task.phase === 'failed' || task.phase === 'cancelled') return undefined
        const id = setInterval(async () => {
          try {
            const next = await api('/task/status', 'POST', { id: task.id })
            setTask(next)
            setPollFails(0)
            if (next.phase === 'done') {
              notify(t('sync.done'))
              api('/deps').then((d) => setDepsMissing((d && d.missing && d.missing.length) || 0)).catch(() => {})
              reload(true)
            } else if (next.phase === 'failed') {
              notify(next.error || t('sync.failed'), 'error')
              reload(true)
            }
          } catch {
            // 继续轮询，但要说出来：连续失败到第三次就在界面上标一句「进度可能停住了」。
            setPollFails((n) => n + 1)
          }
        }, 800)
        return () => clearInterval(id)
      }, [task && task.id, task && task.phase, notify, reload, t])

      const cancel = async () => {
        if (!task) return
        try {
          const next = await api('/task/cancel', 'POST', { id: task.id })
          setTask(next)
        } catch (e) {
          notify(e.message, 'error')
        }
      }

      const rollback = async (syncId) => {
        try {
          await api('/local/rollback', 'POST', { syncId })
          await reload(true)
          notify(t('sync.rollbackDone'))
        } catch (e) {
          notify(e.message, 'error')
        }
      }

      const phaseLabel = (phase) => {
        const key = 'sync.phase.' + phase
        const v = t(key)
        return v === key ? phase : v
      }

      const active = task && task.phase !== 'done' && task.phase !== 'failed' && task.phase !== 'cancelled'

      return h(
        React.Fragment,
        null,
        h(
          Card,
          { title: t('sync.title'), desc: t('sync.desc') },
          peers.length === 0
            ? h('div', { className: 'dlk-empty' }, t('sync.noPeer'))
            : h(
                React.Fragment,
                null,
                h(
                  'div',
                  { className: 'dlk-grid' },
                  h(
                    Field,
                    { label: t('sync.peer'), flex: '1 1 220px' },
                    h(
                      'select',
                      { className: 'dlk-input', value: peerId, onChange: (e) => setPeerId(e.target.value) },
                      peers.map((p) => h('option', { key: p.id, value: p.id }, (p.name || p.host) + ' · ' + p.host + ':' + p.port)),
                    ),
                  ),
                ),
                h('span', { className: 'dlk-label' }, t('sync.direction')),
                h(
                  'div',
                  { className: 'dlk-grid' },
                  h(
                    'button',
                    { type: 'button', className: 'dlk-block', 'data-on': direction === 'push', style: { flex: '1 1 240px' }, onClick: () => setDirection('push') },
                    h('span', { className: 'dlk-check', 'data-on': direction === 'push', 'aria-hidden': 'true', style: { borderRadius: 8 } }),
                    h('span', { className: 'dlk-col' }, h('span', { className: 'dlk-label', style: { color: 'inherit' } }, t('sync.push')), h('span', { className: 'dlk-hint' }, t('sync.pushDesc'))),
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'dlk-block', 'data-on': direction === 'pull', style: { flex: '1 1 240px' }, onClick: () => setDirection('pull') },
                    h('span', { className: 'dlk-check', 'data-on': direction === 'pull', 'aria-hidden': 'true', style: { borderRadius: 8 } }),
                    h('span', { className: 'dlk-col' }, h('span', { className: 'dlk-label', style: { color: 'inherit' } }, t('sync.pull')), h('span', { className: 'dlk-hint' }, t('sync.pullDesc'))),
                  ),
                ),
                h('span', { className: 'dlk-label' }, t('sync.categories')),
                h(
                  'div',
                  { className: 'dlk-group' },
                  (cfg.categories || []).map((c) =>
                    h(Check, {
                      key: c.id,
                      checked: Boolean(cats[c.id]),
                      onChange: (v) => setCats((prev) => ({ ...prev, [c.id]: v })),
                      label: c.label,
                      desc: c.desc,
                    }),
                  ),
                ),
                h(
                  'div',
                  { className: 'dlk-row', style: { marginTop: 2 } },
                  h(Btn, { onClick: scanRemote, busy: scanning }, scanning ? t('common.loading') : t('sync.scanRemote')),
                  remote
                    ? h('span', { className: 'dlk-hint' }, t('sync.remoteSummary').replace('{files}', remote.totalFiles).replace('{size}', fmtBytes(remote.totalBytes)))
                    : null,
                  // 排除规则的后端一直算着，界面以前一个字都不说：勾了「包含凭据」也没法确认生效没有。
                  remote && remote.excludedTotal > 0
                    ? h('span', { className: 'dlk-hint' }, t('sync.excludedLine')
                        .replace('{n}', String(remote.excludedTotal))
                        .replace('{what}', Object.keys(remote.excludedReasons ?? {})
                          .map((r) => (EXCLUDE_LABEL[r] ? t(EXCLUDE_LABEL[r]) : r))
                          .join(' · ')))
                    : null,
                  remote && (remote.excluded || []).length
                    ? h(Btn, {
                        size: 'sm',
                        onClick: () => setShowExcluded((v) => !v),
                        'aria-expanded': showExcluded ? 'true' : 'false',
                      }, showExcluded ? t('sync.excludedHide') : t('sync.excludedShow'))
                    : null,
                ),
                showExcluded && remote && (remote.excluded || []).length
                  ? h(
                      'div',
                      { className: 'dlk-group' },
                      (remote.excluded || []).map((e) => h(
                        'div',
                        { className: 'dlk-row', key: `${e.rel}|${e.reason ?? ''}` },
                        h('span', { className: 'dlk-mono', style: { flex: '1 1 auto', wordBreak: 'break-all' } }, e.rel),
                        h('span', { className: 'dlk-hint' },
                          EXCLUDE_LABEL[e.code] ? t(EXCLUDE_LABEL[e.code]) : (e.reason || '')),
                      )),
                      remote.excludedTotal > (remote.excluded || []).length
                        ? h('span', { className: 'dlk-hint' }, t('sync.excludedRest')
                            .replace('{n}', String(remote.excludedTotal - (remote.excluded || []).length)))
                        : null,
                    )
                  : null,
                remote && remote.summary
                  ? h(
                      'div',
                      { className: 'dlk-group' },
                      Object.keys(remote.summary).map((k) => {
                        const row = remote.summary[k] || {}
                        return h(KV, { k }, (row.files || 0) + ' · ' + fmtBytes(row.bytes || 0))
                      }),
                    )
                  : null,
                h('div', { className: 'dlk-row', style: { marginTop: 4 } },
                  h(Btn, { variant: 'primary', busy: starting, disabled: active, onClick: start }, starting ? t('sync.starting') : t('sync.start')),
                  active ? h(Btn, { onClick: cancel }, t('sync.cancel')) : null,
                ),
              ),
          task
            ? h(
                'div',
                { className: 'dlk-group', style: { marginTop: 4 } },
                h('div', { className: 'dlk-row' },
                  h(Pill, { tone: task.phase === 'done' ? 'ok' : task.phase === 'failed' ? 'err' : 'warn' }, phaseLabel(task.phase)),
                  h('span', { className: 'dlk-hint', style: { flex: '1 1 auto' } },
                    fmtBytes(task.bytes || task.done || 0) + ' / ' + fmtBytes(task.totalBytes || task.total || 0)),
                  task.detail ? h('span', { className: 'dlk-hint' }, task.detail) : null,
                ),
                h('div', { className: 'dlk-bar' }, h('i', { style: { width: pct(task.done || task.bytes, task.total || task.totalBytes) + '%' } })),
                task.error ? h('div', { className: 'dlk-hint', style: { color: 'var(--dsw-alias-state-error-primary,#f85149)' } }, task.error) : null,
                task.progressFailures > 0
                  ? h('div', { className: 'dlk-hint', style: { color: 'var(--dsw-alias-state-warning-primary,#d29922)' } }, t('sync.progressUnreliable', { n: task.progressFailures }))
                  : null,
                pollFails >= 3
                  ? h('div', { className: 'dlk-hint', style: { color: 'var(--dsw-alias-state-warning-primary,#d29922)' } }, t('sync.pollStale', { n: pollFails }))
                  : null,
                task.phase === 'done' && task.result
                  ? h('div', { className: 'dlk-hint' },
                      t('sync.resultLine', {
                        files: task.result.files ?? 0,
                        size: fmtBytes(task.result.bytes ?? 0),
                      }))
                  : null,
                depsMissing > 0 && task.phase === 'done'
                  ? h('div', { className: 'dlk-hint', style: { color: 'var(--dsw-alias-state-warning-primary,#d29922)' } }, t('sync.depsHint', { n: depsMissing }))
                  : null,
              )
            : null,
        ),
        h(
          Card,
          { title: t('sync.recent') },
          (status.recent || []).length === 0
            ? h('div', { className: 'dlk-empty' }, t('sync.noRecent'))
            : h(
                'div',
                { className: 'dlk-scroll' },
                (status.recent || []).map((s) =>
                  h(
                    'div',
                    { className: 'dlk-row', key: s.id, style: { padding: '6px 8px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 9 } },
                    h('div', { className: 'dlk-col' },
                      h('span', { className: 'dlk-label', style: { color: 'inherit' } }, (s.from && (s.from.name || s.from.host)) || s.id),
                      h('span', { className: 'dlk-hint' }, t('sync.metaLine').replace('{time}', timeText(s.finishedAt || s.at || s.startedAt)).replace('{n}', String(s.files || 0)).replace('{size}', fmtBytes(s.bytes || 0))),
                    ),
                    s.rolledBackAt
                      ? h(Pill, { tone: 'warn' }, t('sync.rollbackDone'))
                      : h(ConfirmBtn, { t, size: 'sm', label: t('sync.rollback'), confirmLabel: t('sync.rollbackConfirm'), onConfirm: () => rollback(s.id) }),
                  ),
                ),
              ),
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* phone                                                              */
    /* ------------------------------------------------------------------ */

    function PhonePage() {
      const { t, notify } = useCtx()
      const [phone, setPhone] = useState(null)
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        try {
          setPhone(await api('/phone/status'))
        } catch (e) {
          setPhone({ ok: false, error: e.message })
        }
      }, [])

      useEffect(() => {
        load()
        const id = setInterval(load, 6000)
        return () => clearInterval(id)
      }, [load])

      const act = async (path) => {
        setBusy(true)
        try {
          const r = await api(path, 'POST', {})
          setPhone(r)
          // 端口顺延后记录没写成：服务是起来了，但必须马上告诉人，别等下次重启才发现对不上
          if (r && r.portWriteFailed) notify(t('phone.portWriteWarn', { port: r.port, from: r.fromPort }), 'warn')
          else if (r && r.portMismatch) notify(t('phone.portMismatch', { rec: r.recordedPort, got: r.port }), 'warn')
          // 停止没成功：服务还在跑，得当场说一声，别让人以为已经停了
          if (r && r.stopped === false && r.error) notify(r.error, 'warn')
        } catch (e) {
          notify(e.message, 'error')
        } finally {
          setBusy(false)
        }
      }

      if (!phone) return h('div', { className: 'dlk-empty' }, h(Spinner), ' ', t('common.loading'))

      if (phone.installed === false) {
        return h(Card, { title: t('phone.title'), desc: t('phone.desc') }, h('div', { className: 'dlk-empty' }, t('phone.notInstalled')))
      }

      const running = Boolean(phone.running)
      return h(
        React.Fragment,
        null,
        h(
          Card,
          {
            title: t('phone.title'),
            desc: t('phone.desc'),
            right: h('div', { className: 'dlk-row' },
              running ? h(Pill, { tone: 'ok' }, t('phone.running')) : h(Pill, { tone: phone.paused ? 'warn' : 'err' }, phone.paused ? t('phone.paused') : t('phone.stopped')),
            ),
          },
          phone.error ? h('div', { className: 'dlk-hint', style: { color: 'var(--dsw-alias-state-error-primary,#f85149)' } }, phone.error) : null,
          phone.portMismatch
            ? h('div', { className: 'dlk-hint', style: { color: 'var(--dsw-alias-state-warning-primary,#d29922)' } },
                t('phone.portMismatch', { rec: phone.recordedPort, got: phone.port }))
            : null,
          h(KV, { k: t('phone.port') }, phone.port || '—'),
          phone.recommended ? h(KV, { k: t('phone.recommended') }, h('span', { className: 'dlk-mono' }, phone.recommended)) : null,
          phone.pairCode
            ? h('div', { className: 'dlk-row' },
                h('span', { className: 'dlk-label' }, t('phone.pairCode')),
                h('span', { className: 'dlk-mono', style: { letterSpacing: '.16em', fontSize: 14 } }, phone.pairCode),
                h(CopyBtn, { size: 'sm', text: phone.pairCode, t }),
              )
            : null,
          phone.publicUrl ? h(KV, { k: t('phone.publicUrl') }, h('span', { className: 'dlk-mono' }, phone.publicUrl)) : null,
          (phone.addresses || []).length
            ? h('div', { className: 'dlk-group' },
                (phone.addresses || []).map((url) => h('div', { className: 'dlk-row', key: url },
                  h('span', { className: 'dlk-mono', style: { flex: '1 1 auto' } }, url),
                  h(CopyBtn, { size: 'sm', text: url, t }),
                )),
              )
            : null,
          h('div', { className: 'dlk-divide' }),
          h('div', { className: 'dlk-row' },
            running
              ? h(Btn, { variant: 'danger', busy, onClick: () => act('/phone/stop') }, t('phone.stop'))
              : h(Btn, { variant: 'primary', busy, onClick: () => act('/phone/start') }, t('phone.start')),
            h(Btn, { onClick: load }, t('common.refresh')),
          ),
          h('div', { className: 'dlk-hint' }, t('phone.hint')),
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* diagnostics                                                        */
    /* ------------------------------------------------------------------ */

    function DiagnosticsPage() {
      const { t, notify, status } = useCtx()
      const [diag, setDiag] = useState(null)
      const [error, setError] = useState(null)
      const [logs, setLogs] = useState(null)
      const [loadingLogs, setLoadingLogs] = useState(false)
      const [deps, setDeps] = useState(null)
      const [installing, setInstalling] = useState(null)

      const load = useCallback(async () => {
        try {
          const [nextDiag, nextDeps] = await Promise.all([
            api('/diagnostics'),
            api('/deps').catch(() => null),
          ])
          setDiag(nextDiag)
          if (nextDeps) setDeps(nextDeps)
          setError(null)
        } catch (e) {
          setError(e.message)
        }
      }, [])

      const installDeps = async (ids) => {
        const key = ids && ids.length ? ids.join(',') : 'all'
        setInstalling(key)
        try {
          await api('/deps/install', 'POST', { ids: ids && ids.length ? ids : undefined })
          const next = await api('/deps')
          setDeps(next)
          await load()
          notify(t('diag.depsDone'), 'ok')
        } catch (e) {
          notify(t('diag.depsFail', { msg: e.message }), 'error')
        } finally {
          setInstalling(null)
        }
      }

      useEffect(() => {
        load()
      }, [load])

      const loadLogs = async () => {
        setLoadingLogs(true)
        try {
          const r = await api('/logs')
          setLogs(r.lines || [])
        } catch (e) {
          notify(e.message, 'error')
        } finally {
          setLoadingLogs(false)
        }
      }

      const report = () => {
        const lines = []
        lines.push('# DSH Remote Connect diagnostics')
        lines.push('time: ' + new Date().toISOString())
        if (status) lines.push('version: ' + status.app.version + '\ndataHome: ' + status.app.dataHome + '\ndshHome: ' + status.app.dshHome)
        if (diag) {
          lines.push('', '## checks')
          for (const c of diag.checks || []) lines.push(`- [${c.status}] ${c.label}: ${c.detail || ''}`)
          lines.push('', '## environment')
          for (const k of Object.keys(diag.env || {})) lines.push(`- ${k}: ${diag.env[k]}`)
        }
        if (logs) {
          lines.push('', '## logs')
          for (const l of logs) lines.push(`- ${l.at || ''} ${l.level || ''} ${l.scope || ''} ${l.message || ''}`)
        }
        return lines.join('\n')
      }

      if (error && !diag) return h('div', { className: 'dlk-empty' }, error, h('div', { style: { marginTop: 8 } }, h(Btn, { onClick: load }, t('common.retry'))))
      if (!diag) return h('div', { className: 'dlk-empty' }, h(Spinner), ' ', t('common.loading'))

      const tone = (s) => (s === 'ok' ? 'ok' : s === 'warn' ? 'warn' : 'err')
      const label = (s) => (s === 'ok' ? t('diag.ok') : s === 'warn' ? t('diag.warn') : t('diag.fail'))

      return h(
        React.Fragment,
        null,
        h(
          Card,
          { title: t('diag.checks'), desc: t('diag.desc'), right: h('div', { className: 'dlk-row' },
            h(Btn, { size: 'sm', onClick: load }, t('common.refresh')),
            h(CopyBtn, { size: 'sm', text: report(), label: t('diag.copyReport'), t }),
          ) },
          h('div', { className: 'dlk-group' },
            (diag.checks || []).map((c) =>
              h('div', { className: 'dlk-row', key: c.id },
                h(Pill, { tone: tone(c.status) }, label(c.status)),
                h('span', { className: 'dlk-label', style: { flex: '0 0 110px', color: 'inherit' } }, c.label),
                h('span', { className: 'dlk-hint', style: { flex: '1 1 auto', wordBreak: 'break-all' } }, c.detail || ''),
              ),
            ),
          ),
        ),
        h(
          Card,
          {
            title: t('diag.deps'),
            desc: t('diag.depsDesc'),
            right: deps && deps.missing && deps.missing.length
              ? h(Btn, { size: 'sm', busy: installing === 'all', onClick: () => installDeps([]) }, t('diag.depsInstallAll'))
              : null,
          },
          !deps
            ? h('div', { className: 'dlk-hint' }, t('common.loading'))
            : (deps.missing || []).length === 0
              ? h('div', { className: 'dlk-hint' }, t('diag.depsOk'))
              : h('div', { className: 'dlk-group' },
                  (deps.missing || []).map((id) => {
                    const row = (deps.plugins || []).find((p) => p.id === id)
                    return h('div', { className: 'dlk-row', key: id },
                      h(Pill, { tone: 'warn' }, t('diag.depsMissing')),
                      h('span', { className: 'dlk-label', style: { flex: '0 0 220px', color: 'inherit', wordBreak: 'break-all' } }, id),
                      h('span', { className: 'dlk-hint', style: { flex: '1 1 auto', wordBreak: 'break-all' } }, (row && row.missing ? row.missing.join(', ') : '')),
                      h(Btn, { size: 'sm', busy: installing === id, onClick: () => installDeps([id]) }, t('diag.depsInstall')),
                    )
                  }),
                ),
        ),
        h(
          Card,
          { title: t('diag.env') },
          Object.keys(diag.env || {}).map((k) => h(KV, { key: k, k }, String(diag.env[k]))),
        ),
        h(
          Card,
          { title: t('diag.logs'), right: h(Btn, { size: 'sm', busy: loadingLogs, onClick: loadLogs }, t('diag.loadLogs')) },
          logs === null
            ? h('div', { className: 'dlk-hint' }, t('diag.noLogs'))
            : logs.length === 0
              ? h('div', { className: 'dlk-hint' }, t('diag.noLogs'))
              : h('div', { className: 'dlk-log' }, logs.map((l, i) => h('div', { key: i }, `${l.at || ''} ${String(l.level || '').toUpperCase()} ${l.scope || ''} ${l.message || ''}`))),
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* icon + plugin apply                                                */
    /* ------------------------------------------------------------------ */

    function LinkIcon(props) {
      const size = (props && props.size) || 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M9.5 14.5 14.5 9.5' }),
        h('path', { d: 'M11.2 6.6 13 4.8a3.9 3.9 0 0 1 5.5 5.5l-1.8 1.8' }),
        h('path', { d: 'M12.8 17.4 11 19.2a3.9 3.9 0 0 1-5.5-5.5l1.8-1.8' }),
      )
    }

    const bundle = {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        if (ctx.effect) {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'remote-connect: dictionaries')
        } else {
          ctx.locale.register(NS, { zh, en })
        }
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'remote-connect',
              order: 26,
              label: () => t('nav'),
              locale: NS,
            },
            RemoteConnectSection,
          ),
        )
        ctx.slots.inject('settings.section.icon', () =>
          ctx.slots.register(
            { name: 'settings.section.icon', id: 'remote-connect', locale: NS },
            LinkIcon,
          ),
        )
      },
    }

    return bundle
  },
})
