# 发布手册（合并 / 发版 / 上架）

这份文件只记一件事：**插件改动以后，怎么安全地合并、发版、上架**。
维护者本机有两套目录：一套是自己在用的完整项目（下称「主项目」），一套是这个发布仓。
**不要往主项目里装这个发布包**，两边互不影响，只做单向同步（主项目 → 发布仓）。

---

## 0. 两个目录，别搞混

| 目录 | 角色 |
| --- | --- |
| `<主项目>/` | 维护者自己用的完整项目（不动它、不装发行包） |
| `<发布仓>/` | **发布仓**，对应 GitHub `hanhan9999999999999999999/remote-connect-dsh` |

发布仓结构：

```
index.json                       市场索引（format 1）
plugins/dsh-remote-connect/      唯一插件包
```

---

## 1. 同步源码（单向）

```powershell
$src = '<主项目>\plugins'                                   # 各插件源码所在
$dst = '<发布仓>\plugins\dsh-remote-connect'
robocopy $src\dsh-remote-connect $dst /E /XD node_modules runtime /XF *.bak-* *.log
```

合并后的包**没有**对应的单一源目录，改动通常是先在发布仓里改，验收后再回写到主项目。
回写前先备份到 `<备份目录>\<时间戳>-<任务名>\`。

---

## 2. 合并多个插件时的硬约束（踩过的坑）

1. **一个 `client.js` 只能注册它被加载的那个 id**。DSH 的 `dsh-client-modules/lib/index.js:760` 会报
   `loaded without registering "<id>" via __ModuleLoader__.load`，所以两个 UI 不能靠两次 `load()` 拼进一个包。
   先看哪个 client 是死代码（例如 `dsh-phone-bridge/client.js` 的 `apply()` 早已是空函数），死的那半直接丢。
2. **host 半用同包 import**，不要写 `import(new URL('../dsh-phone-bridge/index.js', import.meta.url))`——
   这种相对路径只有两个包装在相邻目录时才成立，用户单独装就永远走 fallback。
3. **本机绝对路径一律参数化**：`config.bridgeDir` → `config.dir` → 环境变量 → 默认值，四级回落。
4. **能力缺失要能降级**：`installed()` 区分「没装」和「没起来」，前端给安装提示而不是报错。
5. **包名/路由/数据目录/日志名一起改**：改名时 `grep` 一遍旧名，否则数据目录和日志会分裂成两套。

---

## 3. 发版流程

```powershell
cd '<发布仓>\plugins\dsh-remote-connect'
node test/run-all.mjs          # 必须全绿：client-smoke / inventory-guard / deps / bridge-dir / docs-guard / plugin-smoke / e2e
```

1. 改 `package.json` 的 `version`，在 `CHANGELOG.md` 顶部加一节。
2. 提交**插件源码**，拿到 SHA：

   ```powershell
   git add -A; git commit -m "dsh-remote-connect x.y.z: ..."; git rev-parse HEAD
   ```

3. 用这个 SHA 更新 `index.json` 的 `plugins[0].versions[0].source.commit`、
   `version`、`publishTimestamp`（**秒级整数**），**再单独提交一次索引**。
   两次提交是必要的：索引要指向源码那个提交，不能指向包含它自己的提交。

4. 写 JSON **必须无 BOM**：

   ```powershell
   [IO.File]::WriteAllText($p, $txt, (New-Object System.Text.UTF8Encoding($false)))
   ```

   `Set-Content -Encoding UTF8` 会写 BOM，`parseMarketIndex` 直接 `Unexpected token '﻿'`。

5. 用真校验器验一遍（不要只靠眼睛）：

   ```powershell
   node tools/validate-index.mjs          # 在发布仓根目录跑，见第 5 节
   ```

6. 用市场真实参数实装一遍（`npm` 不行，必须 pnpm）：

   ```powershell
   $env:http_proxy='http://127.0.0.1:7891'; $env:https_proxy=$env:http_proxy
   node <pnpm.mjs 路径> `
     --dir $env:TEMP\mk-install-test add `
     "git+https://github.com/hanhan9999999999999999999/remote-connect-dsh.git#<SHA>&path:/plugins/dsh-remote-connect"
   ```

   `<pnpm.mjs 路径>` 取 DSH 自带的那份（`<DSH 安装目录>\dsh-runtimes\*\dependencies\pnpm\bin\pnpm.mjs`），或自己装了 pnpm 就直接 `pnpm add`。

7. 推送（token 只走命令行，不落 `.git/config`、不落 `.git-credentials`）：

   ```powershell
   $cred = (Get-Content "$env:USERPROFILE\.git-credentials" | Select-Object -First 1).Trim()
   $tok  = ([regex]::Match($cred,'://[^:]+:([^@]+)@')).Groups[1].Value
   git -c http.proxy=http://127.0.0.1:7891 push `
     "https://x-access-token:$tok@github.com/hanhan9999999999999999999/remote-connect-dsh.git" main:main
   ```

   PowerShell 会把 git 的 stderr 当错误，看到 `main -> main` 就是成功了，`exit 1` 不算失败。

---

## 4. 市场索引的格式坑（format 1）

```jsonc
{
  "format": 1,
  "title": { "zh": "…", "en": "…" },
  "metadata": {
    // 每一项是 { "title": { "zh": …, "en": … } }，不是直接给字符串
    "categories": { "link": { "title": { "zh": "互联", "en": "Connectivity" } } },
    "labels":     { "remote": { "title": { "zh": "远程", "en": "Remote" } } },
    "sortKeys":   {}
  },
  "plugins": [{
    "name": "dsh-remote-connect",
    "metadata": {
      "category": "link",          // 必须已在上面的 categories 里声明，否则 references undeclared id
      "labels": ["remote"],        // 同理必须已声明
      "keywords": ["remote"]
    },
    "versions": [{
      "version": "1.0.0",
      "publishTimestamp": 1763132400,   // 秒级整数
      "source": {
        "type": "git",
        "url": "https://github.com/…/remote-connect-dsh.git",   // 规范 https，带 .git
        "commit": "<40 位小写 hex>",
        "path": "plugins/dsh-remote-connect"                     // PATH_SEGMENT 只允许 [A-Za-z0-9._@+-]
      }
    }]
  }]
}
```

`localizedText` 给对象时**必须含 `en`**；`icon` 相对索引解析，必须 https 或同源。

---

## 5. 校验脚本

两道，第一道在仓库里、谁都能跑，第二道用 DSH 自己的解析器验真。

### 第一道：`tools/validate-index.mjs`（无依赖）

```powershell
node tools/validate-index.mjs                 # 默认校验仓库根的 index.json
node tools/validate-index.mjs 别的索引.json    # 也可以指定文件
```

它按 format 1 的规则查：`format === 1`、包名正则、`metadata.categories/labels` 必须是 `{title:{zh,en}}` 且插件引用的 id 已声明、git 源必须 https + 40 位小写 commit、`path` 每段合法、以及**文件不能带 BOM**。CI 里也跑这一条（`.github/workflows/test.yml`）。

### 第二道：DSH 真实解析器（`parseMarketIndex`）

第二个参数是**索引 URL 字符串**，不是对象；而第一个参数要**已经 `JSON.parse` 过**——
直接传文本会报 `$ must be an object`（`path: '$', reason: 'must be an object'`）。

```js
import { parseMarketIndex } from 'file:///<DSH 安装目录>/resources/app/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js'
import fs from 'node:fs'
const text = fs.readFileSync('<发布仓>/index.json', 'utf8')
const idx = parseMarketIndex(JSON.parse(text), 'https://raw.githubusercontent.com/hanhan9999999999999999999/remote-connect-dsh/main/index.json')
console.log('ok format=' + idx.format + ' plugins=' + idx.plugins.length)
for (const p of idx.plugins) for (const v of p.versions) console.log(' ', p.name, v.version, JSON.stringify(v.source))
```

第三道是实装：见第 3 节的 pnpm 验证，装完 `node -e "import('dsh-remote-connect')"` 能拿到 `apply/id/inject` 才算通。

---

## 6. 上架两个渠道

### 内置市场（索引源）

DSH「设置 → 插件 → 发现 → 索引源」加：

```
https://raw.githubusercontent.com/hanhan9999999999999999999/remote-connect-dsh/main/index.json
https://cdn.jsdelivr.net/gh/hanhan9999999999999999999/remote-connect-dsh@main/index.json
```

推完立刻能用（raw 有几十秒缓存）。**jsDelivr 那条只当镜像，别当发布验证依据**：它 `s-maxage=43200`，不同边缘节点各存各的，实测同一时刻能同时看到 1.0.0 / 1.0.2 / 最新版三种；要清就用 `https://purge.jsdelivr.net/gh/hanhan9999999999999999999/remote-connect-dsh@main/index.json`，但清完也别指望所有节点立刻一致。验发布一律看 raw 的字节数和 `commit`。

### 社区市场 awesome-dsh-plugin

在 `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin` 提 PR，**一个 PR 最多 3 条**：

- 文件：`data/plugins/hanhan9999999999999999999__remote-connect-dsh--plugins-dsh-remote-connect.yml`
- monorepo 子包：`url` 指到 `…/tree/main/plugins/dsh-remote-connect`，`name` 用 `owner/repo#subname`
- `category` 从官方 taxonomy 选（remote / dev / tools / ui / …），只 `description.en` 必填
- 描述里出现 `: ` 要整段加引号
- 仓库要有 `dsh-plugin` topic；子包 `package.json` 必须声明 `dsh.bundle`

发版后**不用**改这个 yml（它链的是仓库，不是版本号）；只有换仓库名或路径时才需要提新 PR。

---

## 7. 敏感内容红线

- 发布仓里**不许**出现主人自己的规则文件、注入提示词、服务器地址、私钥、token。
  `dsh-prompt-inject` 就是因为把私人条款整段塞进公开仓库被删的；旧历史已经用 orphan 提交重写强推烧掉。
- 每次发版前扫一遍：

  ```powershell
  git grep -nE "BEGIN (RSA|OPENSSH) PRIVATE KEY|sk-[A-Za-z0-9]{24,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}" -- .
  ```

- 一旦发现旧提交里带着敏感内容，**不要只删文件**：重建 orphan 历史再 force push（git 的旧 blob 不会因为删除而消失）。
