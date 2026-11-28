# 更新日志

本文件记录 `dsh-plugin-corpus` 的对外版本变化。

## 1.7.0 — 2026-11-28

### PDF 文字层改用随包 PDFium（1.7.0）

- 移除 pdftotext（GPL-2.0-or-later）与可选 PyMuPDF（AGPL-3.0），改用 **pypdfium2（Apache-2.0）+ PDFium（BSD-3-Clause）**；随 `vendor/rapidocr/site-packages` 分发，用户不需要安装 Python 包。
- 新增 `plugin/lib/pdf_pdfium.py`：按页输出 JSON；支持 CJK CMap（Adobe-GB1 等）与空密码加密 PDF；`lib/pdf.js` 新增 `runPdfiumText()`；`extractor` 改为 `pdfium`。
- 删除 `pdfTextEngine`（不再有 pdftotext/pymupdf 选择）与 `pdf_pymupdf.py`；`pdfPython` 仅用于覆盖 PDFium 的 Python 解释器，留空即用随包 `vendor/rapidocr/`。
- 移除 `vendor/pdftotext/`、相关 GPL 文案与打包校验；`tools/package-plugin.ps1` 改为校验 `pypdfium2` 存在。
- 实测：ANSYS 214 页 0.43 s（纯提取）/约 1.20 s（含字符坐标后处理）；754 页 1.39 s（纯提取）；3000 px 渲染约 137 ms/页。
- 文字层增加基于字符坐标的保守后处理：仅当两个 ASCII 字母之间 `gap > 0.46 × 行高` 时补空格；CJK 占比超过 15% 的页跳过，避免把“km/h”“120”拆开；分页边界始终保留。
- 已知差异：PDFium 空白更少（214 页 489,593 字符 vs pdftotext 577,105），但按页分隔后 token 覆盖基本一致（原始 70,427 vs 70,415；后处理后 70,441，多出的是补回的少量空格）；拼接文本时必须保留分页边界，否则跨页词会粘连。
- 新增测试：PDFium 路径不存在时不可用；随包运行时能提取 CJK 并记录 `pdfText.engine=pdfium`，且不向 CJK/数字之间插空格。
- 项目源码许可证从 GPL-2.0-or-later 改为 **MIT**；历史版本仍按发布时的许可证。随包第三方组件保留各自许可证（PDFium BSD-3-Clause、pypdfium2/OfficeCLI/RapidOCR 等 Apache/MIT/BSD）。
- 1.6.2 的 PyMuPDF 方案未发布，1.7.0 直接替换为 PDFium。

## 1.6.1 — 2026-11-26

### 子代理继承主会话的语料权限

- `authorize()` 现在接受会话链（`subject.sessions`：当前会话 + `parentSession` 祖先链），session 规则命中链上任意一个即生效；子代理、孙代理因此自动继承主会话的 `session` grant。
- 子代理新建集合时，最小自动授权落在**根会话**（链尾），而不是子代理自身；这样主会话与整条链都能访问。
- 面板 `/access` 使用同一会话链，子代理的权限面板也能看到继承来的集合。
- 新增测试：父/子/孙会话继承、无关会话不继承、子代理自动授权落在根会话。

### 文档

- README 按技术写作重写：适用环境、最短可用路径、安装、使用、数据布局、格式与限额、PDF/OCR 流程、配置、故障排查。
- plugin/README、MODEL_GUIDE、INSTALL 同步 1.6.1 与权限继承说明。

## 1.6.0 — 2026-11-16

来源：`Desktop\DSH\学习` 会话的《语料插件待改清单-2026-11-16》（导入「道路勘测设计」合集时暴露的问题）。

### 新建集合自动授权（P1）

- `corpus_ingest` / `corpus_import` / `corpus_structure` / `corpus_summarize_session` 遇到**尚不存在、且当前会话没有任何 grant** 的集合时，自动补一条最小授权：优先 `session`、其次 `workspace`，`paths` 只含该集合名，绝不写 `*`。
- 返回体新增 `autoGranted` 与 `autoGrant`（规则原文、备份路径、审计文件）；审计追加到 `<root>/.corpus/audit/auto-grant.jsonl`。
- 安全边界：`default` 保持 `deny`；集合已存在、命中显式 `deny`、策略文件损坏时一律不自动放行；策略写入仍走 `savePolicy()`（备份 + 临时文件 rename）。
- 新增 `plugin/lib/autogrant.js`；`access.js` 增加 `readPolicySafe` / `ruleAppliesTo` / `policyDeniesTarget` / `policyAllowsTarget`。

### 大 Office 文件自动瘦身（P2）

- 源文件超过单文件上限（默认 256 MiB）时，对 DOCX/XLSX/PPTX 自动生成瘦身副本：不解压、按条目原样复制，只跳过 `ppt|word|xl/media/*.{mp4,mov,avi,wmv,mkv,webm,mp3,wav,m4a,aac,flac,ogg}`、`*/embeddings/oleObject*.bin`、`*/fonts/*.{fntdata,odttf}`。
- 不修改 rels 与 `[Content_Types].xml`，原文件不动；`warnings` 写明忽略了多少个条目 / MB，`meta.slimmed` 记录。
- `zip.js` 新增 `writeZip()` 与 `rewriteZip()`（含 CRC32，支持跳过条目、保留压缩数据）。
- 实测：336.5 MB / 134 页课件 → 58.6 MB（146 ms），officecli 提取 134 页、27,285 字符正常。

### OCR 质量与预算（P3/P4）

- Windows OCR 渲染不再按 DIP 尺寸：新增 `ocrRenderHeight`（默认 3000 px 目标高），按 `page.Size` 反算 `DestinationWidth/Height`；修复 PowerShell 里 `$page.Size` 存入变量后读空导致宽度变成 1 px 的问题（改为直接访问属性）。
- 新增 RapidOCR（PP-OCRv4）引擎：`ocrEngine: auto|windows|rapidocr`；**完整包内置运行时**（CPython 3.12 + `vendor/rapidocr/site-packages`，约 280 MB），无需用户装 Python，`ocrPython` 只用于覆盖成外部 venv。Windows 上用 `Windows.Data.Pdf` 把页面渲染成 PNG，再交给 `rapidocr_ocr.py` 识别，**不要求随包装 PyMuPDF**；Python 侧只用 `rapidocr_onnxruntime + opencv-python + numpy`。完整 zip 约 125 MB。
- 逐页预算从固定 1500 ms/页改为 `ocrPageTimeoutMs`（默认 6000 ms/页），总预算 = 页数 × 每页预算，下限 15 分钟、上限 60 分钟；超时/失败写进 `meta.ocr.error` 并合并进最终错误信息，不再静默降级。
- `meta.ocr` 记录 `{ engine, fallback, renderHeight, pages, failures, error }`；`warnings` 说明引擎回退。
- 实测（JTG D20 第 40 页，3000 px）：Windows OCR 仍会把 `3.5` 认成 `3 巧`、`km/h` 认成 `k 禳`；RapidOCR 输出 `设计速度（km/h）`、`3`、`35`、`1/250` 等，单页含渲染约 5.7 秒。

### 任务查询（P5）

- `corpus_status(jobId)` 同时查 reindex（`job-*`）与 ingest（`ingest-*`）任务，返回 `kind: 'reindex' | 'ingest'`；找不到时提示可用空参查看 `active` / `ingest.active`。

### 公式白名单（P6）

- `formulas.js` 的 `lineIsFormula` 增加摘要行白名单：`对象：`、`文本：`、`图形关系：`、`图片：`、`表格：`、`形状：`、`位置：`、`尺寸：`、`Slide N` 开头的行不再被包成 `$$...$$`。

### 验收

- 新增 `tests/test-v16.mjs`（ZIP 重写 / Office 瘦身 / 公式白名单 / OCR 预算与引擎回退 / 自动授权与 deny 边界），并接入 `tools/test-all.ps1`。
- `test-plugin-mount.mjs` 增加“新集合自动授权”用例；未授权但**已存在**的集合仍按预期拒绝。


## 1.5.0 — 2026-10-30

### PDF 逐页提取（文字层 + OCR 混合，保证内容完整）

- 文字层按 `pdftotext` 的分页符拆页，逐页判断：**有可读文字层的页原样保留，只对没有文字层/乱码的页做 Windows OCR**，最后按页序合并。
- OCR 脚本新增 `-Pages "1-3,7"` 页码范围：一次加载 PDF、只渲染缺文字的页；超时按缺页数放宽（15–30 分钟），仍是异步子进程，不占宿主事件循环。
- 修复 pdftotext 分页尾部空段被误删的问题：末尾的扫描页现在也会被 OCR 补齐，不会静默丢页。
- `.meta.json` 新增 `pdfPages`：`{ total, text, ocr, weak, empty, ocrRuns }`；`extractor` 新增 `pdf-mixed`。
- 实测：
  - 纯文字 PDF（214 页）≈ 6.6 秒（204 页文字层 + 10 页图页 OCR）；
  - 混合 PDF（2 页文字 + 2 页扫描）≈ 1.5 秒，只 OCR 缺的 2 页；
  - 纯扫描书（386 页 / 24.4 MB）≈ 90 秒，386 页全部 OCR。

### 移除纯 JS PDF 解析兜底

- **根因**：PDF 文字层不可用时，纯 JS 兜底 `extractPdfText` 会把 PDF 里每个 `DCTDecode`/`JPXDecode` 图片流也当文本解码。一本 386 页、24.4 MB 的扫描书实测占满宿主主线程 **13 分钟仍未结束**（手动复现时该 node 进程累计 CPU 812 秒），期间 DSH 的「载入历史」、消息发送、面板请求全部卡住——用户看到的就是“导入不了 + 界面假死”。
- 移除 `plugin/lib/pdf.js` 中的纯 JS 文字层解析（`extractPdfText`/`streamChunks`/`textFromContent`）。
- PDF 提取现在明确依赖随包 `vendor/pdftotext`（官方完整包均包含）；缺失时给出明确错误，不再尝试纯 JS 解析。
- `tools/package-plugin.ps1` 移除 `-WithoutPdftotext` 开关，只产出完整包。
- 新增 `tests/test-extract.mjs` 用例：逐页拆页/缺页判断/页码压缩/OCR 输出解析/合并，以及“文字层 PDF 不再走纯 JS”。

## 1.4.2 — 2026-10-30

### 性能护栏（大导入不再拖住宿主）

- `corpus_import` 改为异步核心 + 协作式让出：逐文件 `await`，每 32 个文件或 8ms 让出一次事件循环。实测 600 个文件导入期间 DSH 宿主最大事件循环停顿 5ms；旧实现是一整段同步复制（同规模约 0.7–1.3 秒无法响应）。
- `corpus_import` 只对前 40 个文件预生成目录，其余由 `corpus_outline` 按需生成，避免一次导入同步写 200 份目录。
- 所有工具输出统一走 `boundJson` 硬上限（默认 24000 字符，可配置 `maxToolOutputChars`）：超限时逐级压缩长字符串与长数组，标记 `_truncated` 并保持合法 JSON，避免单次调用把几十 KB 文本写进会话历史。
- 提示词目录缓存从 15 秒延长到 60 秒，并在导入/摄取/重建/删除/结构化后主动失效。
- 面板 `/overview`、`/files`、`/import/status` 与文件列表轮询加 1.5 秒 TTL 缓存，不再每次轮询都扫描语料根、逐个读 `.meta.json`。
- 索引 `worker` 创建失败时，主线程回退改为按集合分片让出，并写 warn 日志，便于定位「大重建为什么卡」。
- 新增 `perfLogMs`（默认 250ms）：单次 `corpus_import` 超过阈值写 warn 日志。
- 新增 `tests/test-perf.mjs`，覆盖让出器、输出上限、TTL 缓存与导入期间的事件循环停顿。

### 兼容性

- 工具仍为 13 个、面板路由仍为 18 条；工具参数只新增可选配置，不破坏既有调用。
- `engine.importInto` 由同步改为 `Promise`（插件内部与测试已同步更新）。

## 1.4.1 — 2026-10-29

- 右栏「语料权限 → 全局」把原来的「全局拒绝」区域改为「全局访问」。
- 默认拒绝时，可给指定合集添加 `workspace: "*"` 的 grant，对所有工作区/会话放行。
- 默认允许时提示该规则冗余；全局拒绝不再在面板中编辑。

## 1.4.0 — 2026-10-29

- 新增 PDF 文字层质量闸门：检查空格比例、符号/控制字符、超长无空格串和 PDF/JPEG 二进制标记。
- `pdftotext` 或纯 JS 输出不可读时不再直接当正文；自动转 Windows OCR。
- OCR 仍不可读时导入失败并给出错误，不再把压缩流乱码写入 `processed/`。
- 扫描版 PDF 的标题优先使用源文件名，避免把 OCR 页眉当标题。

## 1.3.1 — 2026-10-28

### 发布自动化

- 增加 GitHub Actions `.github/workflows/publish.yml`：GitHub Release 发布后自动恢复 vendor 二进制并执行 `npm publish --provenance`。
- 配置 npm Trusted Publisher（GitHub Actions + `publish.yml`），不再依赖长期 bypass-2FA token。
- 本版本内容与 1.3.0 相同，作为 Trusted Publisher 的首次验证发布。

### 验证

- 全量 `tools/test-all.ps1` 通过；客户端静态验证 388/388。

## 1.3.0 — 2026-10-28

### 导入稳定性

- 浏览器一次选择多个大文件时按 36 MiB base64 上限自动拆批，顺序等待每批完成，避免超过 48 MiB 请求体上限导致 `Failed to fetch`；单批超限时服务端返回明确 413。
- 支持直接粘贴 Windows「复制为路径」产生的带引号路径，自动去掉首尾引号。
- 本机路径单文件上限从 100 MiB 提高到 256 MiB。

### Office 导入

- DOCX/XLSX/PPTX 统一走 officecli；读取 text / annotated / outline，PPT 额外读取 connector / chart 并渲染整份版式缩略图。
- PPT 提示词要求按页描述对象关系、分组、连接线、图表逻辑，不再允许用「图示略」跳过。
- Office 专用结构化提示词；视觉可用时把对象结构摘要 + 版式图一起交给模型，不可用时回退纯文本结构。
- 修复 officecli 继承系统 TEMP/TMP 被 ACL 拒绝的问题。

### 公式

- DOCX/PPTX OMML、XLSX 单元格公式、HTML MathML、PDF 公式行、图片 OCR 文本均进入统一公式处理；XLSX 输出 `Sheet!Cell: =...`。
- 小代理公式要求继续覆盖所有导入格式。

### 扫描版 PDF

- Windows OCR 改为逐页容错：单页渲染/识别失败只标记该页，不中止整本 PDF。
- OCR 超时提高到 15 分钟、输出缓冲提高到 128 MiB；修正正斜杠路径导致 Windows.Data.Pdf 打不开的问题。

### 文件命名

- processed Markdown 使用源文件名词干（保留中文、空格，仅替换 Windows 非法字符），不再使用 AI 标题命名；AI 标题仍保留在 front matter 和正文标题。
- 同一源文件重复导入仍使用独立文件夹；文件名冲突自动追加 -2、-3。

### 验证

- 全量 `tools/test-all.ps1` 通过；客户端静态验证 388/388。
- 工具 13 个、HTTP 路由 18 条；版本号 1.3.0。

## 1.2.0 — 2026-10-28

- 导入（ingest / structure / corpus_import）时生成文档结构目录：章节、小节、起止行号、摘要、关键词。
- 新增 `corpus_catalog`（文档卡片/行数/章节数）与 `corpus_outline`（按路径查看/按需生成目录）两个工具。
- sessionPrompt 改为注入文档卡片与目录约定，模型在会话开始即可知道有哪些文档、多少行、多少章，并知道用 `corpus_outline` 定位第几行。
- 目录 JSON 存于 `.corpus/outlines/`，不进入检索分块；兼容 processed 旁的旧版 outline 文件。
- 工具 13 个；HTTP 路由仍为 18。

## 1.1.0 — 2026-10-28

### 外部打开

- 主按钮直接读取 Windows 文件关联（UserChoice → HKCR → OpenWithList）打开软件；没有关联时才弹出系统选择器。
- 修复 Electron 应用被当成 Node 启动的问题：启动外部程序时清理 ELECTRON_RUN_AS_NODE / ELECTRON_NO_ATTACH_CONSOLE 环境变量（VS Code 可正常打开 GUI）。
- 按钮只显示默认应用图标，没有关联时显示文件夹图标；右侧下拉箭头保留系统软件选择器。
- 文件列表的文件名、类型列和图标统一跟随“处理后语料”的类型（例如 PDF 处理后为 .md，就显示 .md/MD 和 Markdown 图标）。
- 集合列表继续支持嵌套子目录树状展示、中文/空格/符号集合名。

### 清理

- 删除已废弃的插件级应用选择弹窗、`openers.js`、`/openers` API 与相关复制串。
- 删除重复的 `ReindexHelp`、未使用的图标组件、首行解析函数和旧事件名。
- 移除 `countLatexFormulas`、`decodeHexString` 等无引用函数。
- HTTP 路由从 19 条精简为 18 条；工具仍为 11 个。

### 兼容性

- 客户端静态验证 388 项通过，全部本地验收通过。
- 项目源码 GPL-2.0-or-later；OfficeCLI Apache-2.0；Poppler/pdftotext GPL-2.0-or-later。

## 1.0.0 — 2026-10-27

**版本号重置为 1.0.0，作为面向中国大陆用户的新基线。**

### 公式识别与 LaTeX

- HTML MathML 转成 `$...$` / `$$...$$`。
- Word/PowerPoint 内嵌 OMML 公式转成 LaTeX；docx 正文内联保留，OfficeCLI/PPTX 额外生成“公式（LaTeX）”小节。
- Markdown/文本中的 `\(...\)`、`\[...\]`、Unicode 数学符号统一规范化。
- PDF 提取后识别公式行并包成 LaTeX 公式块；结构力学教材实测保留 2,614 个 `$$...$$` 公式块。
- 内置小代理提示词明确要求公式用 LaTeX，插图可写“图示略”，但公式、标注和关键数字必须保留。
- 新增 `tests/test-formulas.mjs`，支持 `CORPUS_TEST_FORMULA_PDF` 对真实 PDF 做回归。

### 批量导入

- 浏览器文件选择支持多选，多个文件作为同一批导入同一个集合。
- 本机路径模式支持多行，每行一个文件或目录，目录递归扫描。
- 未填写集合时自动创建 `import-日期-时间` 集合，批量文件全部进入该集合。
- 导入结果继续统一触发一次集合重建。

### 文档

- 所有 Markdown 文档统一为简体中文。
- 新增/更新安装、架构、公式和批量导入说明。

### 兼容性

- 工具仍为 11 个，HTTP 路由为 19 条。
- 客户端静态测试更新到 388 项。
- 集合名支持中文、字母、数字、空格和常用符号（≤64 字符）；不再限制为 ASCII。
- 集合内支持子目录并继续嵌套；文件列表按集合/子目录树状分组，可逐级展开。
- 主按钮读取 Windows 默认关联直接打开，无关联时打开系统选择器并记住；文件列表显示完整扩展名并按处理后语料类型显示图标；按钮只显示默认应用图标，右侧箭头保留系统选择器。
- 导入不再保存源文件；移除原件查看、缩略图与相关路由。
- 项目源码采用 GPL-2.0-or-later；OfficeCLI Apache-2.0，Poppler/pdftotext GPL-2.0-or-later。
