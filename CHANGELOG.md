# 更新日志

本文件记录 `dsh-plugin-corpus` 的对外版本变化。

## 未发布 — 导入产物按源文件命名

- 每个源文件的 processed Markdown 现在使用源文件名词干（保留中文、空格，仅替换 Windows 非法字符），不再使用 AI 标题或提取标题命名；AI 标题仍保留在 front matter 和正文标题中。
- 同一源文件重复导入仍落在各自独立文件夹；文件名冲突时自动追加 -2、-3。

## 未发布 — 大批次导入修复

- 浏览器导入多个大文件时，把 base64 JSON 按 36 MiB 上限自动拆成多批，顺序等待每批导入完成，避免超过服务端 48 MiB 请求体上限导致 `Failed to fetch`。
- 单批超过 48 MiB 时服务端返回明确的 413 错误，不再直接断开连接。
- 单文件仍受 25 MiB 上限；超过 25 MiB 的文件继续建议用「本机路径」导入。

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
