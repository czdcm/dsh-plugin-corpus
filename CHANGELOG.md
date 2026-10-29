# 更新日志

本文件记录 `dsh-plugin-corpus` 的对外版本变化。

## 未发布 — PDF 导入质量修复

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
