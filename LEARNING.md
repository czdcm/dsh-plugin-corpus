# dsh-plugin-corpus 学习指南

> 这是一份“从零理解并动手改这个插件”的路线图，不是 API 手册。  
> 目标：看懂它为什么这样分层，能独立加一个工具 / 面板功能 / 文件格式，并能测试、部署、打包。

---

## 1. 先定位：它到底是什么

`dsh-plugin-corpus` 不是独立应用，而是 **DeepSeek Harness（DSH）的一个插件**，同时包含两半：

```
┌─────────────────────────────────────────────────────────┐
│ DSH Web GUI（浏览器 / Electron 渲染进程）                │
│  plugin/lib/client.js  ← React 面板 UI（IIFE bundle）     │
│      │ fetch 同源 HTTP                                   │
└──────┼──────────────────────────────────────────────────┘
       │
┌──────▼──────────────────────────────────────────────────┐
│ DSH 宿主进程（Node.js 24 + Cordis）                      │
│  plugin/lib/index.js   ← 插件入口：工具 / 提示词 / 路由   │
│  panel.js              ← /api/dsh-plugin-corpus/*        │
│  engine.js             ← 扫描 / SQLite 索引 / 检索 / 读  │
│  jobs.js               ← worker 后台重建                  │
│  ingest*.js / extract* ← 文档提取、导入、内置小代理        │
│  access.js / policy.js ← 工作区/会话/路径 ACL             │
│  settings.js / trash.js← 根目录迁移 / 软删除              │
└──────┬──────────────────────────────────────────────────┘
       │ 文件系统 + node:sqlite
┌──────▼──────────────────────────────────────────────────┐
│ 语料根（默认 ~/.dsh/corpus）                              │
│  <collection>/...processed/*.md + .meta.json             │
│  .corpus/index/*.sqlite、config、trash                    │
└─────────────────────────────────────────────────────────┘
```

一句话：**DSH 提供 agent 循环、LLM、工具注册、Web 面板插槽；本插件提供“文件语料库”的存储、索引、检索、导入、权限、UI。**

---

## 2. 技术栈总览

### 2.1 编程语言

| 语言 | 用在哪 | 大致规模 | 学习优先级 |
|---|---|---|---|
| **JavaScript（ESM，Node.js）** | 宿主全部逻辑、客户端 UI | 约 9,000 行（`plugin/lib/*.js`，以实际文件为准） | ★★★★★ |
| **JavaScript（.mjs 测试）** | 15 个自包含验收脚本 | 以实际文件为准 | ★★★★ |
| **PowerShell 5.1** | Windows OCR、测试/部署/打包脚本 | ~340 行 | ★★（只改 Windows 能力时） |
| **SQL** | SQLite 建表 / 查询 / 插入 | 嵌在 `engine.js` | ★★★ |
| **JSON / YAML** | 插件清单、配置、策略、state | 少量 | ★★ |
| **Markdown** | 语料内容、文档 | 项目文档 | ★ |
| HTML/CSS | 没有独立文件；HTML 在 `extract.js` 里解析，UI 用 inline style | — | ★ |

> 没有 TypeScript、没有 Webpack/Vite 构建步骤、没有前端测试框架。  
> 客户端是手写 IIFE + `React.createElement`，由 DSH client-modules 直接加载。

### 2.2 运行时与框架

| 技术 | 角色 | 入口 |
|---|---|---|
| **Node.js 24** | 宿主运行时；`node:sqlite`、`worker_threads`、`fs` | DSH 自带 Node |
| **Cordis** | DSH 的插件/依赖注入/生命周期框架 | `apply(ctx)`、`ctx.inject`、`ctx.effect` |
| **DSH Tools** | 工具注册与执行 | `defineTool`、`ctx.tools.register` |
| **DSH LLM / Attachments / AgentDefaultModel** | 内置小代理的模型调用、图片附件、默认模型 | `ctx.get('llm')` 等 |
| **React** | 客户端 UI；函数组件 + hooks，无 JSX | `const React = require('react')` |
| **Schemastery** | 插件配置 schema（默认值/范围） | `export const Config` |
| **SQLite（node:sqlite）** | 每集合一份索引，WAL | `DatabaseSync` |
| **Windows PowerShell 5.1 + WinRT** | PDF 渲染/OCR | `ocr_windows.ps1` |
| **Poppler pdftotext** | 文字版 PDF 直接提取 | `vendor/pdftotext/` |
| **OfficeCLI** | Office 文档文本提取（优先），失败回退纯 JS | `vendor/officecli/` |
| **纯 JS ZIP+XML** | docx/xlsx/pptx 兜底解析 | `zip.js` + `office.js` |
| **Git / PowerShell** | 版本管理、部署、测试、打包 | `tools/*.ps1` |

### 2.3 测试与交付

- 测试：**纯 Node `.mjs` 脚本**，自写 `assert/ok`，`os.tmpdir()` 造临时数据；`tools/test-all.ps1` 统一跑。
- 部署：`tools/deploy.ps1` 把 `plugin/`（含 `vendor/`）复制到 `~/.dsh/plugins/dsh-plugin-corpus`。
- 打包：
  - `tools/package-plugin.ps1` → 可安装插件 zip（唯一形态：含完整 vendor 与许可证）

---

## 3. 目录与模块地图

```
dsh-plugin-corpus/
├─ plugin/
│  ├─ package.json          插件清单：版本、dsh.bundle/client 注入、exports、files
│  ├─ cordis.patch.yml      组合补丁：向 DSH 组合插入 corpus 插件
│  └─ lib/
│     ├─ index.js           ★ 宿主入口：Config、工具、提示词、webServer、dispose
│     ├─ panel.js           ★ HTTP API：overview/files/search/read/reindex/status/policy/access/import/settings/delete/gallery
│     ├─ outline.js         章节/小节/起止行号目录生成与持久化
│     ├─ engine.js          ★ 文件扫描、SQLite 索引、检索、按行读、集合统计
│     ├─ jobs.js            ★ 重建任务管理（worker_threads + 锁）
│     ├─ reindex-worker.js  worker 入口：调用 engine.reindex 并通过 postMessage 报进度
│     ├─ lock.js            跨进程锁（.corpus/index/.lock）
│     ├─ access.js          ACL 判定：deny > grants > default；workspace/session；过期
│     ├─ policy.js          策略文件读写、校验、备份
│     ├─ extract.js         19 种格式 → 文本/图片；HTML、Office、PDF、OCR 调度
│     ├─ zip.js             纯 JS ZIP 中央目录读取（deflate）
│     ├─ office.js          纯 JS docx/xlsx/pptx XML 解析兜底
│     ├─ pdf.js             随包 pdftotext + 逐页质量闸门 + PowerShell OCR
│     ├─ ingest.js          导入任务：路径/上传、per-import 布局、AI 回退、重建
│     ├─ ingest-agent.js    内置小代理：固定 system prompt 的单轮 LLM 调用（文本/图片）
│     ├─ structure.js       主会话接口：仓库/目录/文件/文本 → 结构化 processed
│     ├─ session-transcript.js 会话公开消息投影 → transcript
│     ├─ settings.js        根目录解析/迁移、junction/copy、corpus-root.json
│     ├─ trash.js           软删除（文档/集合 → .corpus/trash）
│     ├─ client.js          ★ 浏览器 UI：左栏页、右栏权限、导入、文件列表、设置
│     ├─ ocr_windows.ps1    内置 Windows OCR（PDF 渲染 + Media.Ocr）
├─ tests/                   纯 Node 验收（不依赖第三方测试框架）
├─ tools/                   部署、测试、打包脚本
├─ README.md                安装、使用与工具/API 总览
├─ CHANGELOG.md             对外版本说明
├─ THIRD_PARTY_NOTICES.md   第三方许可证
├─ LICENSE                  GPL-2.0 全文
└─ LEARNING.md              本文件
```

---

## 4. 关键调用链（按这个顺序理解）

### 4.1 插件启动

```
DSH 读取 profile → cordis.patch.yml 插入 corpus
  → plugin/lib/index.js 的 apply(ctx, config)
     ├─ dshHomeOf(ctx)、expandRoot(...)
     ├─ createJobRunner({root})
     ├─ createIngestAgent({ctx, config})
     ├─ createIngestManager({root,...})
     ├─ createStructureService({...})
     ├─ ctx.tools.register(...) × 13
     ├─ ctx.inject(['systemPrompt'], ...)
     └─ ctx.inject(['webServer'], ...) → createPanelRoutes(...)
```

要学的 Cordis 点：

- `apply(ctx, config)` 是插件生命周期入口；
- `ctx.inject(['webServer'], cb)`：服务晚挂载也能等到；
- `ctx.effect(fn, label)`：注册副作用并在卸载时清理；
- `dispose`：`jobs.dispose()`、`ingest.dispose()`。

### 4.2 模型检索语料

```
corpus_search 工具
  → scopeOf(exec.agent)              # workspace + session
  → authorize(dshHome, subject, collections)  # ACL
  → search(root, {collections, query, limit})
      → 打开 .corpus/index/<collection>.sqlite
      → SELECT chunks ... LIKE / ripgrep 后端
  → 返回 {hits:[{collection,path,title,heading,lines,score,snippet}]}
corpus_read
  → 再次校验 ACL，然后 readFile(root, path)
```

重点：**不是把所有语料塞进提示词**，而是“提示词只列集合/标题，按需检索、按行读”。

### 4.3 导入文档

```
corpus_ingest 工具 / 面板 POST /import
  → ingest.start({paths/uploads, collection, ai, index})
      → 后台任务（同一时刻一个）
      → extractDocument(file)  # HTML/PDF/Office/图片
      → 若 AI 开启：ingest-agent.structure() / structureImages()
      → 写 <collection>/<import>/processed/ + .meta.json
      → jobs.start({names:[collection]})
```

要学的 Node 点：`fs.promises`、`child_process.execFile`、流、超时/abort、临时目录清理、错误回退。

### 4.4 主会话总结仓库/会话

```
corpus_structure({path|text, collection, instructions})
  → structure.run()
      → 仓库扫描（代码/文档/配置，跳过 .git/node_modules/构建产物）
      → 生成材料 → agent.structure()（单轮同步 LLM）
      → per-import 落盘 → reindex.start()
  → 返回 body/target/git/stats/warnings

corpus_summarize_session({collection})
  → buildSessionTranscript(session.deriveMessages())
      → 只保留人类 user / assistant 可见文本 / tool-call / 少量 tool result
      → 跳过 reasoning、注入上下文、图片二进制
  → structure.run({kind:'session'}) → processed
```

要学的 DSH 点：`Session.deriveMessages()` 公开投影、工具 `exec.agent.session`、`llm.stream`、`attachments.saveImages` + image content block。

### 4.5 面板/客户端

```
浏览器：
  client.js IIFE
    → window.__ModuleLoader__.load({id:'dsh-plugin-corpus', factory})
    → require('react')
    → exports.inject = ['locale','slots','sidebarRightTabs']
    → exports.apply(ctx)
        ├─ sidebar.panellist 一行「语料库」
        ├─ main 槽整页 CorpusPage
        └─ sidebarRightTabs.register + sidebar.right.pane.tab（权限）
    → fetch('/api/dsh-plugin-corpus/...') 同源 HTTP
```

要学的 React 点（不用 JSX）：

- `h = React.createElement`；
- 函数组件 + `useState/useEffect/useCallback/useRef`；
- 组件内 state 不要随便加在 `CorpusPage`，否则测试的 hook 下标会变（见测试注意事项）；
- 条件渲染用三元/null，列表用 `.map` 并给 `key`。

### 4.6 后台重建

```
jobs.start()
  → acquireLock(root, names)  # .corpus/index/.lock
  → new Worker(reindex-worker.js, {workerData})
      → engine.reindex(root, {names, force, onProgress})
      → worker.postMessage({type:'progress'|'done'|'error'})
  → status()/wait()/dispose()
```

要学的 Node 点：`worker_threads`、跨进程文件锁、`postMessage`、异常回退到主线程。

### 4.7 设置/迁移与删除

```
POST /settings/root
  → migrateRoot({dshHome,currentRoot,newRoot})
      → 校验绝对路径/空目录/不嵌套
      → 同卷：rename + 旧路径 junction；跨卷：copy + restartRequired
      → 写 ~/.dsh/corpus-root.json（优先级高于 config.corpusRoot）

POST /delete {path|collection}
  → deleteDocument / deleteCollection
      → 移到 .corpus/trash/<时间>/
      → 文档删除触发 reindex
```

要学的点：Windows junction、`fs.renameSync`、跨卷回退、软删除、进程内路径别名。

---

## 5. 数据模型（务必先懂）

### 5.1 语料根

```
<CORPUS_ROOT>/
├─ <collection>/
│  └─ <YYYYMMDD-HHmmss>-<slug>/
│     ├─ processed/<标题>.md     ← 模型只读这里
│     └─ .meta.json
├─ .corpus/
│  ├─ index/<collection>.sqlite
│  ├─ outlines/<hash>.json
│  ├─ config.json
│  ├─ import-tmp/<jobId>/
│  └─ trash/<时间>/...
└─ ...
```

### 5.2 SQLite 索引表

`engine.js` 里三张表：

```sql
docs(id INTEGER PRIMARY KEY, path TEXT, title TEXT, bytes INTEGER, mtime INTEGER, hash TEXT, chunks INTEGER)
chunks(doc_id INTEGER, ord INTEGER, heading TEXT, text TEXT, start_line INTEGER, end_line INTEGER)
meta(key TEXT PRIMARY KEY, value TEXT)
```

- 粗排：`LIKE`（like 后端）或 `ripgrep`；
- 精读：`corpus_read` 按行返回，不整篇塞上下文；
- 旧版遗留的 `originals/` 不会被索引（`scanCollection` 跳过）；新导入不再创建。

### 5.3 ACL

`~/.dsh/corpus-access.json`：

- `default: deny`
- `grants[]`：workspace/session + paths/glob + 可选 `expiresAt`；`workspace: "*"` 是全局访问（对所有工作区/会话生效）
- `deny[]` 优先于 grants
- 工具调用、提示词列表、面板 `/access` 都走同一套 `authorize()`

---

## 6. 阅读顺序（建议 2–3 天看一遍）

### Day 1：宿主最小闭环

1. `plugin/package.json`、`plugin/cordis.patch.yml`
2. `plugin/lib/index.js` 前 150 行（Config、dshHome、apply、工具注册）
3. `plugin/lib/engine.js`：`scanCollection`、`buildIndex`、`search`、`readFile`
4. `plugin/lib/jobs.js` + `reindex-worker.js` + `lock.js`
5. `plugin/lib/panel.js` 的 `/overview`、`/search`、`/read`、`/reindex`、`/status`

### Day 2：权限、导入、小代理

6. `access.js` + `policy.js`
7. `extract.js` → `zip.js` / `office.js` / `pdf.js`
8. `ingest.js` + `ingest-agent.js`
9. `structure.js` + `session-transcript.js`
10. `settings.js` + `trash.js`

### Day 3：客户端

11. `client.js` 顶部 IIFE/注入/注册
12. `CorpusPage` 的 state 与 `loadOverview`
13. `ImportSection`
14. `CorpusGallery`（文件列表、折叠、行删除）
15. `CorpusRootSettings`、权限面板
16. 最后看测试：`tests/test-plugin-mount.mjs`、`test-client-bundle.mjs`

> 不要一开始通读 `client.js`（3000+ 行）。先看 `index.js` 和 `panel.js`，知道数据从哪来，再看 UI 怎么消费。

---

## 7. 可以拿来练手的小任务

| 难度 | 任务 | 涉及 |
|---|---|---|
| ★ | 加一个 `corpus_count` 工具：返回集合/文档数 | `defineTool`、`scopeOf` |
| ★ | 面板 `/overview` 增加“最近导入时间”字段 | `panel.js`、client 渲染 |
| ★★ | 文件列表增加“按名称/时间排序”按钮 | React state、gallery 数据 |
| ★★ | 新增一种纯文本格式（如 `.adoc`） | `SUPPORTED_EXTENSIONS`、`extract.js` |
| ★★ | 给集合卡加“导出 JSON”按钮 | 新 HTTP 路由、下载 |
| ★★★ | 把单轮小代理改为分块 map-reduce 总结大仓库 | `structure.js`、`ingest-agent.js` |
| ★★★ | 给导入任务加取消按钮 | `ingest.js`、AbortController |
| ★★★ | 用 Windows Shell 提取真实文件类型图标 | PowerShell/WinRT + `/icon` 路由 |

每个练习都要补一个 `tests/test-*.mjs`，再跑 `tools/test-all.ps1`。

---

## 8. 测试的“坑”（重要）

- 测试是**手写 Node 脚本**，没有 Jest/Vitest；用 `assert` + `ok()`。
- 客户端测试用假的 `React.createElement` + 全局 `useStateIndex`：
  - `CorpusPage` 的 state 顺序/数量一变，`ImportSection` 的 hook 下标就会变；
  - 新组件尽量独立，别在 `CorpusPage` 顶部随便加 `useState`；
  - 需要看 `tests/test-client-bundle.mjs` 里的 `IMPORT_HOOK_OFFSET`。
- `test-corpus.mjs` 读真实语料根并建索引；其余测试用 `os.tmpdir()`，跑完会清理。
- 改 `client.js` 后至少跑：
  ```powershell
  $node = "C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
  & $node --check plugin\lib\client.js
  & $node tests\test-client-bundle.mjs
  ```

---

## 9. 开发/部署/打包命令

```powershell
cd <repo>

# 全部本地验收
powershell -NoProfile -ExecutionPolicy Bypass -File tools\test-all.ps1

# 部署到本机插件目录（含 vendor）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\deploy.ps1
# 然后完全重启 DSH

# 打包：可安装插件 zip（唯一形态：含完整 vendor 与许可证）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\package-plugin.ps1
```

常用路径：

- 插件部署：`%USERPROFILE%\.dsh\plugins\dsh-plugin-corpus`
- 语料根：`%USERPROFILE%\.dsh\corpus`（可在面板设置/迁移）
- 权限：`%USERPROFILE%\.dsh\corpus-access.json`
- 根目录状态：`%USERPROFILE%\.dsh\corpus-root.json`（设置后才有）
- 插件配置：DSH profile 的 `~/.dsh/profiles/desktop` 下

---

## 10. 推荐学习资料

DSH 自带文档（可在 DSH 的 `dsh-docs` 语料库中检索）：

| 文档 | 学什么 |
|---|---|
| `dsh-docs/architecture.md` | DSH 整体架构、turn/step、session log |
| `dsh-docs/capability-seams.md` | 服务/能力接缝：tools、llm、webServer、sessions |
| `dsh-docs/subsystems/session.md` | Session、事件日志、`deriveMessages()` |
| `dsh-docs/subsystems/tools.md` | ToolExecution、执行管线、权限 |
| `dsh-docs/subsystems/llm-streaming.md` | Message、ContentBlock、流式返回 |
| `dsh-docs/cookbook/extension-cookbook.md` | 插件形态：UI 插件、协议驱动等 |
| `dsh-docs/cookbook/adding-a-workspace-package.md` | 本地包/workspace 结构 |
| “1. Your first plugin” 系列 | Cordis 插件最小示例 |
| `dsh-docs/subsystems/persistence.md` | 会话持久化与存储 |

外部基础：

- Node.js：ES Modules、`fs/promises`、`child_process`、`worker_threads`、`node:sqlite`
- React：函数组件、hooks、`createElement`、受控输入
- SQLite：建表、索引、参数化查询、WAL
- Cordis：插件、Service、`inject`、`effect`
- PowerShell：`System.WindowsRuntimeSystemExtensions`、`Windows.Media.Ocr`、`Windows.Data.Pdf`
- Web 安全：同源校验、路径穿越、`realpath`、XSS（React 默认转义）

---

## 11. 术语速查

| 术语 | 在本项目中的意思 |
|---|---|
| 集合（collection） | 语料根下的一级目录 |
| processed | 给模型检索/读取的结构化 Markdown |
| 源文件 | 由用户自行管理；插件不再保存或读取 |
| per-import 布局 | 每次导入一个文件夹，含 processed/.meta.json |
| 小代理 | 固定提示词、单轮、后台的 LLM 调用 |
| 主会话接口 | `corpus_structure` / `corpus_summarize_session` 等工具 |
| junction | Windows 目录联接；根目录迁移后旧路径指向新路径 |
| 软删除 | 移到 `.corpus/trash`，可人工恢复 |
| 增量/全量重建 | 只更新变化文件 / 丢弃索引重新切块 |
| Cordis | DSH 的插件与依赖注入框架 |
| 能力接缝 | DSH 暴露的 `ctx.llm`、`ctx.sessions`、`ctx.webServer` 等服务 |

---

## 12. 下一步建议

1. 先读 [`README.md`](README.md) 和 [`plugin/README.md`](plugin/README.md)，了解安装、工具与 API。
2. 按 Day 1 顺序读宿主，用 `corpus_search`/`corpus_read` 实际跑一遍。
3. 做一个 ★ 练习（`corpus_count`），跑 `test-plugin-mount`。
4. 改客户端一个小 UI，跑 `test-client-bundle`。
5. 最后再碰 OCR/Junction 这些 Windows 特性。

> 记住这个项目最核心的三条设计：
> **1) 文件为中心，索引可重建；2) 模型只读 processed，插件不保存源文件；3. 一切写操作先过 ACL，删除/迁移都可回退。**
