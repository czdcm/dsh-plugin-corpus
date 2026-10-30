# dsh-plugin-corpus 模型操作指南（MODEL_GUIDE）

> 读者：DSH 中的模型（也适合用户查阅）。
> 适用版本：**1.5.0+**（PDF 逐页提取、无纯 JS PDF 兜底）。
> 目标：用户提出“导入 / 查找 / 整理 / 删除 / 重建 / 改合集”等语料库操作时，模型能选对工具、填对参数、按正确顺序执行并验证结果。

---

## 0. 先记住四条原则

1. **先读后写**：任何写操作前，先用 `corpus_access` 确认权限，用 `corpus_catalog` / `corpus_list` 确认集合与文档确实存在。
2. **危险操作先确认**：删除、覆盖、改名、移动、批量导入，都要先向用户说明影响并得到确认。
3. **只通过插件工具操作语料**：不要直接改 `.corpus/`（索引、大纲、回收站）或 `corpus-access.json`；只有“插件没有工具”的操作（改名、移动、编辑正文）才用文件系统，且要按本指南的步骤做。
4. **结果可核验**：引用要给 `path` + 行号；导入/重建后要用 `corpus_search` 或 `corpus_list` 验证，不要只说“已完成”。

> 工具返回是 JSON 字符串。输出有硬上限（默认 24000 字符），超限会被压缩并带 `_truncated: true`；看到它就缩小查询范围或分页，不要反复重试同样的调用。

---

## 1. 概念模型

```text
语料根（root，默认 ~/.dsh/corpus，可用 ~/.dsh/corpus-root.json 迁移）
├─ <集合A>/                        集合 = 一级目录，目录名就是集合名
│  ├─ foo.md                       文本语料（corpus_import 导入的就是这种平铺文件）
│  └─ 20261030-141500-某文档/        corpus_ingest 每次导入生成一个文件夹
│     ├─ processed/某文档.md        模型只读这里
│     └─ .meta.json                 导入元数据（标题/来源/格式/pdfPages 等）
├─ <集合B>/
└─ .corpus/                         插件内部，不要手改
   ├─ index/<集合>.sqlite           每个集合一份索引，可重建
   ├─ outlines/<hash>.json          文档大纲缓存（按文档路径哈希）
   ├─ trash/                        软删除回收站
   ├─ import-tmp/                   导入临时目录
   └─ config.json                   每集合的索引后端与文件过滤
```

- **集合**：`<root>/<集合名>/`。集合名规则：1–64 字符，以中文/字母/数字开头，不能含 `/ \ : * ? " < > |`，不能以点或空格结尾，不能用 Windows 保留名（CON/PRN/AUX/NUL/COM1…）。
- **文档**：集合内的文本文件（`.md` 为主，也支持 `.txt/.json/.yaml` 等）。模型只能通过 `corpus_read` 读，且只读 `processed/` 或集合内文件；不能读 `.corpus/`、`originals/`、符号链接。
- **权限**：`corpus-access.json`，默认 **拒绝**；按工作区/会话 + 集合/路径（支持 glob）授权，`deny` 优先。模型**只能查看**，不能修改。
- **任务**：索引重建（reindex）与文档摄取（ingest）都是后台任务；**同一时刻各只跑一个**。

---

## 2. 工具速查

| 工具 | 读写 | 用途 | 关键参数 |
|---|---|---|---|
| `corpus_access` | 读 | 我有哪些集合/路径权限 | 无 |
| `corpus_catalog` | 读 | 目录卡片（标题/行数/章节目录/摘要） | `collection?`、`limit?`（默认 200） |
| `corpus_search` | 读 | 关键词检索段落 | `query`（空格分隔，全部命中）、`limit?`（默认 8，上限 50）、`collection?` |
| `corpus_outline` | 读 | 文档章节/行号目录 | `path`、`depth?`（1/2，默认 2） |
| `corpus_read` | 读 | 按行读原文（带行号） | `path`、`from?`（默认 1）、`lines?`（默认 120，上限 400） |
| `corpus_list` | 读 | 集合与文件列表 | `collection?`、`limit?`（每集合默认 200） |
| `corpus_status` | 读 | 索引/任务状态 | `jobId?` |
| `corpus_import` | 写 | 导入本机文本文件/目录（复制，不转换） | `path`、`collection`、`prefix?`、`move?`、`extensions?`、`index?` |
| `corpus_ingest` | 写（后台） | 导入文档（PDF/Office/HTML/图片/文本）并转 Markdown | `path`、`collection`、`prefix?`、`ai?`、`index?` |
| `corpus_structure` | 写 | 仓库/目录/文件/文本 → 结构化总结入库 | `path`/`text`、`collection?`、`prefix?`、`title?`、`instructions?`、`maxFiles?`、`maxChars?`、`import?`、`reindex?` |
| `corpus_summarize_session` | 写 | 把会话总结入库 | `collection`、`prefix?`、`title?`、`instructions?`、`maxChars?`、`sessionId?`、`import?`、`reindex?` |
| `corpus_reindex` | 写（后台） | 重建索引（增量/强制） | `collection?`（省略=全部可访问集合）、`force?` |
| `corpus_delete` | 写 | 软删除文档或集合 | `path` 或 `collection`（二选一） |

---

## 3. 只读操作（找资料）

### 3.1 `corpus_access` —— 先看权限

```json
{}
```

返回 `root`、`accessFile`、`policy.default`、`workspace`、`session`、`collections[]`、`fileCount`。
返回 `collections` 为空时，说明当前会话没有任何集合权限；**不要**尝试其他集合，直接告诉用户去右侧栏「语料权限」加授权。

### 3.2 `corpus_catalog` —— 先看目录，不要盲搜

```json
{ "collection": "机械" }
```

每篇文档返回 `path`、`title`、`lineCount`、`chapters`、`sections`、`summary`、`outline` 等。先看卡片再决定读哪篇；没有 `outline` 的文档，直接调 `corpus_outline` 生成。

### 3.3 `corpus_search` —— 关键词检索

```json
{ "query": "齿轮 模数", "limit": 5 }
```

- 多个词是 **AND**（全部命中），最多取前 4 个词；中文直接写词，不要写整句。
- 命中项含 `path`、`title`、`heading`、`lines`（行号范围）、`snippet`。
- 若返回 `ok:false, building:true`，说明索引正在后台建，等 `corpus_status` 或稍后重试；不要反复猛调。

### 3.4 `corpus_outline` —— 定位章节行号

```json
{ "path": "机械/20261030-xxx/processed/机械原理.md", "depth": 1 }
```

返回 `chapters[]`（`title/startLine/endLine/summary/keywords`）和 `sections[]`（depth≥2 时）。之后用 `corpus_read` 按 `startLine` 读。

### 3.5 `corpus_read` —— 按行读原文

```json
{ "path": "机械/20261030-xxx/processed/机械原理.md", "from": 1200, "lines": 80 }
```

- 每次最多 400 行；`text` 每行带 `行号| ` 前缀，方便引用。
- 返回 `totalLines`、`to`、`truncated`；`truncated:true` 表示后面还有。
- 路径必须相对语料根、在已知集合内；不要传绝对路径或 `..`。

### 3.6 `corpus_list` —— 文件清单

```json
{ "collection": "机械", "limit": 50 }
```

返回每个集合的 `docs`、`chunks`、`indexedAt`、`files[]`（`path/title/chunks/bytes`）。适合核对“导入后到底进了哪些文件”。

### 3.7 `corpus_status` —— 任务与索引状态

```json
{ "jobId": "job-1793..." }
```

返回 `active`（正在跑的任务）、`recent`（最近任务，含 `result`）、`ingest`（导入任务）、`collections`（每集合 docs/chunks/indexedAt）。
判断“现在能不能写”：`active == null` 且 `ingest.active == null`。

---

## 4. 写入操作（加语料）

### 4.1 `corpus_import` —— 导入本机文本文件/目录（不转换）

适合：已有 Markdown/TXT/JSON 等文本；把整个目录搬进语料。

```json
{
  "path": "C:\\docs\\manual",
  "collection": "机械",
  "prefix": "手册",
  "extensions": ".md,.txt",
  "index": true
}
```

- 只收文本扩展名（默认 `.md/.markdown/.mdx/.txt/.rst/.text/.json/.yaml/.yml`；可用 `extensions` 覆盖）。
- 目录会递归扫描；跳过隐藏项、符号链接、二进制、超过单文件上限（默认 4 MiB）的文件。
- `move:true` 表示复制成功后删除源文件（默认 false）。
- 单次最多 5000 个文件（可传 `maxFiles`，上限 20000）。
- 返回 `imported/skipped/bytes/fileCount/files`（最多 100 条）、`notes`、`outlinesGenerated/outlinesPending`、`jobId`。
- 导入后默认触发后台重建；`jobId` 非空时用 `corpus_status` 轮询。

### 4.2 `corpus_ingest` —— 导入文档（PDF/Office/HTML/图片），转 Markdown

适合：PDF、DOCX/XLSX/PPTX、HTML、图片、CSV 等；需要“提取正文”的场景。

```json
{ "path": "C:\\Users\\me\\Downloads\\机械原理.pdf", "collection": "机械", "ai": false }
```

- **后台任务**：立即返回 `started/jobId/state`；同一时刻只能跑一个 ingest，忙时返回 `busy:true`，等 `corpus_status` 里 `ingest.active` 为空再试。
- `ai:true`（默认）会让内置小代理再总结/结构化一次（更慢，消耗模型调用）；`ai:false` 只做确定性提取，通常够用。
- PDF 是**逐页提取**：文字层用随包 `pdftotext`，缺文字层/乱码的页逐页用 Windows OCR，最后按页合并；扫描书 386 页约 90 秒，期间宿主保持响应。
- 每次导入生成 `<collection>/<时间戳>-<文件名>/processed/<文件名>.md` + `.meta.json`；重复导入不会覆盖，会生成新文件夹。
- 限制：单次最多 200 个文件；浏览器上传单文件 25 MiB，本机路径单文件 256 MiB。
- `prefix` 只影响目录层级，不影响提取。

### 4.3 `corpus_structure` —— 仓库/网页文本 → 结构化总结入库

适合：GitHub 仓库（先 `git clone` 到本机）、一个目录、单个文件，或主会话抓到的网页/API 文本。

```json
{
  "path": "C:\\Github\\some-repo",
  "collection": "Development_Experience",
  "instructions": "重点总结架构与数据流，面向二次开发",
  "maxFiles": 300,
  "maxChars": 48000
}
```

- `path` 与 `text` 二选一；`text` 适合直接粘贴网页正文。
- **同步**返回结构化 Markdown（`body`，默认最多 24000 字符，超出截断），同时写入 `processed/` 并触发重建（`import:true` 时）。
- `import:false` 只返回总结、不落盘。
- 仓库会自动带 Git 信息（remote/branch/commit），并跳过 `node_modules/.git/dist` 等目录。

### 4.4 `corpus_summarize_session` —— 把这次会话总结入库

```json
{ "collection": "Development_Experience", "instructions": "保留部署与排错经验" }
```

- 读取当前会话的公开消息（不读 system/developer、不读图片二进制），生成 Markdown 写入 `processed/` 并重建。
- `maxChars` 默认 60000（上限 160000）；`sessionId` 可指定其他会话。

### 4.5 创建集合（没有独立工具）

集合在**第一次导入时自动创建**：`corpus_import` / `corpus_ingest` 的 `collection` 填一个不存在的合法名字即可。
不要为了“建空集合”去导一个占位文件；如果用户确实要空集合，让用户在文件系统建目录或在面板导入区输入新集合名。

### 4.6 等任务、做验证（写操作的收尾）

1. `corpus_status` 看 `active` / `ingest.active`；
2. 任务 `done` 后 `corpus_list`（核对文件数）或 `corpus_search`（核对能搜到）；
3. 把 `jobId`、目标集合、文件数、验证结果一起回复用户。

---

## 5. 管理与维护

### 5.1 重建索引 `corpus_reindex`

```json
{ "collection": "机械", "force": false }
```

- 增量：按文件 mtime/size 只处理变化的文件；`force:true` 全量重切。
- 省略 `collection` = 重建当前会话可访问的全部集合。
- 后台单任务：忙时返回 `busy:true`；完成后用 `corpus_status` 确认 `docs/chunks`。
- 索引可随时删掉重建（`.corpus/index/<集合>.sqlite`），数据在文件里不会丢。

### 5.2 删除文档 / 集合 `corpus_delete`

```json
{ "path": "机械/20261030-xxx/processed/机械原理.md" }
```

```json
{ "collection": "机械" }
```

- **软删除**：内容移到 `.corpus/trash/<时间>/`（集合移到 `.corpus/trash/collections/`），可人工恢复。
- 删文档时，如果路径在 `processed/` 下，会把整个导入文件夹（processed + .meta.json）一起移走。
- 删除文档会自动触发该集合重建；删除集合会清理该集合索引。
- 有重建任务在跑时会拒绝（提示“还有重建任务在运行”）；先等任务结束。
- **执行前必须向用户确认对象与范围**；不要删集合来“清理一下”。

恢复删除（模型在用户明确要求时执行）：把 `.corpus/trash/<时间>/...` 里的内容移回原集合目录，然后 `corpus_reindex`。

### 5.3 编辑已有语料（没有编辑工具）

插件**不提供**“改正文”的工具。按场景选择：

1. **改一两个字/补一段**：用文件工具直接编辑 `<root>/<集合>/.../processed/<文件>.md` → 删除该文档的大纲缓存（或让用户重导入）→ `corpus_reindex`（增量会按 mtime 重切）。
   - 大纲缓存按文档路径哈希存放在 `.corpus/outlines/`，直接改正文后 `corpus_outline` 仍可能返回旧目录；强制刷新办法：删除 `.corpus/outlines/*.json`（全部大纲，安全，按需重建）。
2. **整篇替换**：直接覆盖同一路径的文件 → `corpus_reindex`。
3. **源文件重新导入**：用 `corpus_ingest` 重新导一份（会生成新文件夹，不覆盖旧的）；确认后删旧文档。

编辑后必须验证：`corpus_search` 能搜到新内容、`corpus_outline` 行号合理。

### 5.4 集合改名（没有工具）

集合名 = 目录名，改名是“文件系统操作 + 重建 + 权限同步”：

1. 确认没有运行中的 reindex/ingest（`corpus_status`）；
2. 把 `<root>/<旧名>/` 重命名为 `<root>/<新名>/`；
3. 清理旧索引文件 `<root>/.corpus/index/<旧名>.sqlite`（含 `-wal/-shm`；不清理也不会被使用，只是占空间）；
4. 更新 ACL：`~/.dsh/corpus-access.json` 里所有引用旧集合名的 `grants/deny.paths` 改成新名（**这是用户配置，改前确认；优先让用户在右侧栏「语料权限」里改**）；
5. `corpus_reindex`（新集合）；
6. 验证：`corpus_list` / `corpus_search` 用新集合名能命中。

注意：`.corpus/outlines` 里旧路径的大纲会失效（路径变了，按新路径重新生成即可）。

### 5.5 把文档移到另一个集合（没有工具）

1. 移动文件：
   - 平铺文件：`<root>/<旧集合>/a.md` → `<root>/<新集合>/a.md`；
   - ingest 文件夹：整个 `<root>/<旧集合>/<时间戳>-<名>/` 移过去，并修改其 `.meta.json` 里的 `"collection"` 字段；
2. `corpus_reindex` 两个集合（或省略 collection 重建全部）；
3. 验证两个集合的 `corpus_list`。

大纲按新路径哈希，移动后 `corpus_outline` 会自动生成新的，不需要额外处理。

### 5.6 权限管理（模型只读）

- 查看：`corpus_access`；
- 修改：**模型不能改**。指导用户打开右栏「语料权限」：
  - 当前会话 / 当前工作区加 grant（可设有效期）；
  - 「全局访问」用 `workspace: "*"` 让某集合对所有工作区开放；
  - 默认动作 allow/deny 的切换也在面板。
- 权限不足的典型报错：`没有访问集合 X 的权限` / `没有导入到集合 X 的权限`。

### 5.7 根目录迁移（面板操作）

语料根可整体搬迁：面板「语料库 → 语料库根目录」；迁移状态记录在 `~/.dsh/corpus-root.json`。模型不直接改这个文件；如用户要求，指导其在面板操作（同卷会建立 junction，当前进程可不重启；跨卷需要重启 DSH）。

### 5.8 备份 / 导出

- 直接复制整个语料根（含 `.corpus/trash`）即可；不要在 reindex/ingest 运行时复制。
- 单篇导出：`corpus_read` 读全文（分页）或直接用文件工具复制文件。

---

## 6. 常见任务配方（用户话术 → 执行步骤）

### 配方 A：“把这本 PDF / 这个目录加进《机械》”

1. `corpus_access` 确认能访问 `机械`；没有就停，提示用户授权。
2. `corpus_ingest`（PDF/Office/图片）或 `corpus_import`（纯文本目录），`collection:"机械"`，`ai:false`（除非用户要 AI 总结）。
3. `corpus_status` 轮询到任务 done；`corpus_list` 核对文件数；`corpus_search` 抽查关键词。

### 配方 B：“新建一个《考研数学》合集”

1. 直接 `corpus_import` / `corpus_ingest` 时把 `collection` 填 `"考研数学"`（合法名）；
2. 返回后 `corpus_list` 确认集合已出现。不要先建空目录再导。

### 配方 C：“把《机械》改名成《机械设计》”

按 5.4 执行；先向用户确认“改名会同步改目录与权限配置”，并提醒旧链接/引用要更新。

### 配方 D：“把这篇文档从 A 集合挪到 B 集合”

按 5.5 执行；确认两边集合都存在、文件不重名；移动后重建并验证。

### 配方 E：“删掉这篇 / 这个合集”

1. 明确对象（路径或集合名）并让用户确认；
2. `corpus_delete`；
3. 回复里说明“已移入回收站，可恢复”，给出集合与路径。

### 配方 F：“帮我找 X 的原文，带行号”

1. `corpus_search` 关键词；
2. 命中后用 `corpus_outline` 看章节，再 `corpus_read` 读对应行；
3. 回答中引用 `path` + 行号，不臆造。

### 配方 G：“搜不到 / 索引坏了”

1. `corpus_status` 看该集合 `docs/indexedAt`；
2. `corpus_reindex`（必要时 `force:true`）；
3. 完成后重试 `corpus_search`；仍空则 `corpus_list` 确认文件是否真的在集合里。

### 配方 H：“把这个 GitHub 仓库存进语料”

1. `git clone` 到本机（不要直接抓网页）；
2. `corpus_structure` 传仓库路径 + `collection` + `instructions`；
3. 用返回的 `target` 做 `corpus_read` 抽查；`corpus_search` 验证可检索。

### 配方 I：“把这次会话总结进语料”

`corpus_summarize_session`，`collection` 必填（例如 `Development_Experience`），可给 `instructions` 指定重点。

### 配方 J：“给它开权限 / 让另一个工作区也能用”

模型不能改 ACL；指导用户在右栏「语料权限」操作（会话/工作区 grant 或全局访问）。

---

## 7. 限制与错误处理

### 7.1 限制速查

| 项 | 限制 |
|---|---|
| 工具输出 | 默认 24000 字符，超出压缩并标 `_truncated` |
| `corpus_read` | 每页最多 400 行 |
| `corpus_search` | 默认 8 条，最多 50；关键词最多 4 个 |
| `corpus_catalog` / `corpus_list` | 每集合默认 200 条 |
| `corpus_import` | 单次默认 5000 文件（上限 20000）；单文件默认 4 MiB；只收文本 |
| `corpus_ingest` | 单次 200 文件；上传 25 MiB/文件；本机 256 MiB/文件 |
| 后台任务 | reindex 单任务、ingest 单任务 |
| 集合名 | ≤64 字符，规则见 §1 |
| 文本截断 | 单文档提取文本上限 8 MiB（超出截断） |

### 7.2 常见错误 → 处理

| 错误/返回 | 含义 | 处理 |
|---|---|---|
| `没有访问集合 X 的权限` | ACL 拒绝 | `corpus_access` 查看，提示用户面板授权 |
| `没有导入到集合 X 的权限` | 写权限缺失 | 同上 |
| `已有导入任务在运行` | ingest 忙 | 轮询 `corpus_status` 的 `ingest.active` |
| `已有重建任务在运行` | reindex 忙 | 等它结束，或 `corpus_status` 看进度 |
| `还有重建任务在运行，等任务结束后再删除语料` | 删除被拒 | 先等任务 |
| `找不到文件` / `不在已知集合内` | path 错 | 用 `corpus_list` 拿准确相对路径 |
| `PDF 没有可读文字层…` | 加密件/OCR 不可用 | 告知用户；不要写空文件 |
| `_truncated: true` | 输出被压缩 | 缩小 `limit`/行数、分页读 |
| `building: true` | 索引在建 | 稍后重试，不要连发 |

---

## 8. 安全与禁忌

- **不要**直接读写 `.corpus/`（索引、大纲、回收站、临时目录）；只有 §5.3–5.5 的文件系统操作例外，且需用户确认。
- **不要**修改 `~/.dsh/corpus-access.json`；权限只能由用户在面板改。
- **不要**在用户没确认时删除集合、覆盖文件、批量移动。
- **不要**用 `corpus_read` 读非语料路径（源码、系统文件）；它不是通用文件浏览器。
- **不要**在正文里引用没读过的内容；语料内容以 `corpus_read` 结果为准。
- **不要**自动推送 GitHub/发布（用户明确要求才做）。
- 大文件优先“本机路径”而不是浏览器上传；导入前确认磁盘空间。

---

## 9. 术语表

| 术语 | 含义 |
|---|---|
| 语料根 root | 所有集合所在的顶层目录（默认 `~/.dsh/corpus`） |
| 集合 collection | 一级目录，目录名即集合名 |
| processed | 导入生成的 Markdown 所在目录（模型只读这里） |
| 索引 index | `.corpus/index/<集合>.sqlite`，检索用，可重建 |
| 大纲 outline | 章节标题 + 起止行号，`.corpus/outlines/` 缓存 |
| `.meta.json` | ingest 导入的元数据（标题/来源/格式/页数统计等） |
| 回收站 trash | `.corpus/trash/`，软删除内容，可人工恢复 |
| grant / deny | ACL 授权/拒绝规则，deny 优先 |
| job | reindex 或 ingest 的后台任务 |
