# dsh-plugin-corpus

DeepSeek Harness（DSH）的本地语料库插件。它把本机文档放进一个可整体搬迁的目录，按集合建 SQLite 索引，向模型提供检索、按行读取和导入工具，并在 DSH 面板中提供导入、浏览、权限管理与根目录迁移。

当前版本 **1.6.1**。这是 DSH 插件，不是独立应用；宿主代码只在 DSH 进程启动时加载，安装或升级后必须**完全退出并重启 DSH**。

## 适用环境

| 项 | 要求 |
|---|---|
| 操作系统 | Windows 10/11 x64（PDF 渲染与 OCR 依赖 Windows 能力） |
| 宿主 | 已安装并可用的 DeepSeek Harness |
| 磁盘 | 完整插件解压后约 321 MB（含 OCR 运行时），语料另计 |
| Python | 不需要；完整包已内置 RapidOCR 运行时 |
| 开发（可选） | Node.js 24、PowerShell 5.1 |

## 最短可用路径

1. 从 [GitHub Releases](https://github.com/czdcm/dsh-plugin-corpus/releases) 下载 `dsh-plugin-corpus-v1.6.1-plugin.zip`。
2. 解压到 `%USERPROFILE%\.dsh\plugins\`，得到 `%USERPROFILE%\.dsh\plugins\dsh-plugin-corpus\`。
3. 确认 DSH profile 已注册该插件：`dependencies` 含 `dsh-plugin-corpus`，`dsh.profile.bundles` 含 `dsh-plugin-corpus`。用插件管理器安装时会自动完成；手工解压的注册步骤见 [INSTALL.md](INSTALL.md)。
4. 完全退出并重新启动 DSH。
5. 打开左侧栏 **语料库**，选择文件或填写本机路径，指定集合后开始导入。
6. 打开右侧栏 **语料权限**，给当前工作区或会话授权该集合。
7. 在对话中让模型检索，例如「在语料库里找……」。

成功信号：

- 左侧栏能看到新集合，文件列表出现导入项；
- `corpus_search` 能命中新内容；
- 会话提示词中出现可访问集合与文档卡片。

## 安装

### Release 包（推荐）

Release 只发布完整包，包含 OfficeCLI、pdftotext 和 RapidOCR 运行时。

1. 下载 `dsh-plugin-corpus-v<版本>-plugin.zip` 并解压到 `%USERPROFILE%\.dsh\plugins\`；
2. 按 [INSTALL.md](INSTALL.md) 完成 profile 注册（`link:` 依赖 + `bundles`）；
3. 完全重启 DSH。

默认语料根是 `%USERPROFILE%\.dsh\corpus`，可在面板「语料库 → 语料库根目录」修改或迁移。

### npm / 插件市场

```powershell
dsh plugin add dsh-plugin-corpus
```

安装后完全重启 DSH。npm 包：<https://www.npmjs.com/package/dsh-plugin-corpus>。

> npm 包同样带 vendor 二进制，体积较大；首次安装可能比普通插件慢。

### 源码（仅开发）

GitHub 源码仓库不包含 `officecli.exe`、`pdftotext.exe` 和 `vendor/rapidocr/`（体积原因被 `.gitignore` 排除），clone 后直接部署只能得到降级能力。需要完整能力时使用 Release 包，或先把 vendor 文件放回 `plugin/vendor/`。

```powershell
git clone https://github.com/czdcm/dsh-plugin-corpus.git
cd dsh-plugin-corpus
powershell -NoProfile -ExecutionPolicy Bypass -File tools\deploy.ps1
# 完全重启 DSH
```

## 使用

### 面板

- **导入**：浏览器可多选文件；也可填写多行本机路径（每行一个文件或目录），目录会递归扫描。同一批导入进入同一个集合。
- **集合**：留空集合名会自动创建 `import-日期-时间`；集合名支持中文、字母、数字和常用符号，最长 64 字符。
- **语料文件**：按集合分组，显示类型、大小和导入时间；每行可「用外部软件打开」，删除为两次确认的软删除。
- **检索**：只用于定位，结果给出路径和行号，不内嵌预览。
- **根目录**：查看、复制、打开、迁移语料根。

### 模型工具

模型通过 13 个工具访问语料库，所有工具都受 ACL 约束：

| 工具 | 用途 |
|---|---|
| `corpus_search` | 按关键词检索可访问集合 |
| `corpus_read` | 按路径和行范围读取 processed 文档 |
| `corpus_list` | 列出集合与文档 |
| `corpus_catalog` | 返回集合/文档卡片、行数、章节摘要 |
| `corpus_outline` | 返回章节标题与起止行号；缺失时按需生成 |
| `corpus_reindex` | 启动增量或全量索引重建 |
| `corpus_status` | 查看重建/导入任务与索引状态；`jobId` 同时支持 `job-*` 与 `ingest-*` |
| `corpus_import` | 导入本机文本文件或目录 |
| `corpus_ingest` | 后台提取文档并导入（PDF/Office/图片等） |
| `corpus_structure` | 把仓库、目录、文件或文本总结为结构化语料 |
| `corpus_summarize_session` | 把会话总结成语料 |
| `corpus_delete` | 软删除单篇文档或整个集合 |
| `corpus_access` | 解释当前工作区/会话的权限范围 |

给模型的操作细则见 [plugin/MODEL_GUIDE.md](plugin/MODEL_GUIDE.md)。

### 权限

默认拒绝。策略文件：`%USERPROFILE%\.dsh\corpus-access.json`。

- 按 `workspace` 或 `session` 授权，`paths` 支持集合名、目录前缀和 glob；
- 显式 `deny` 优先于 `grants`，过期授权自动忽略；
- `session` 授权沿 `parentSession` 链被子代理继承；子代理新建集合时，自动授权落在根会话；
- 面板「语料权限 → 全局」可给指定集合开放 `workspace: "*"`。

本机 ACL 文件不要提交到仓库；模板见 `config/corpus-access.example.json`。

## 数据布局

```text
<语料根>/
├─ <集合>/
│  ├─ <子目录>/              可选，可继续嵌套
│  └─ <导入文件夹>/
│     ├─ processed/          模型检索与读取的 Markdown
│     └─ .meta.json          导入元数据（格式、来源、页数统计等）
└─ .corpus/
   ├─ index/<集合>.sqlite    每集合一份索引，可重建
   ├─ config.json
   ├─ outlines/<hash>.json   文档目录缓存
   ├─ import-tmp/
   ├─ audit/                 自动授权审计
   └─ trash/                 软删除内容，可手动恢复
```

模型只读 `processed/`。插件不保存源文件；索引和大纲都可以从文件重新生成。

## 支持格式与限额

| 项 | 说明 |
|---|---|
| 文本 | `.md` `.markdown` `.mdx` `.txt` `.text` `.csv` `.json` `.yaml` `.yml` |
| 网页 | `.html` `.htm` |
| PDF | 文字层用随包 `pdftotext`；缺文字层/乱码的页逐页 OCR，最后按页合并 |
| Office | `.docx` `.xlsx` `.pptx`：优先 officecli，失败回退纯 JS |
| 图片 | `.png` `.jpg` `.jpeg` `.webp` `.gif` `.bmp` `.tif` `.tiff`：视觉模型可用时结构化，否则 OCR/占位 |
| 浏览器上传 | 单文件 25 MiB |
| 本机路径 | 单文件 256 MiB；Office 超限自动瘦身（跳过内嵌视频/字体/oleObject） |
| 单次导入 | `corpus_import` 默认 5000 文件；`corpus_ingest` 200 文件 |
| 读取 | `corpus_read` 每页最多 400 行 |
| 工具输出 | 默认 24000 字符，超出压缩并标 `_truncated` |
| OCR | 渲染目标高 3000 px；逐页预算默认 6000 ms，总预算 15–60 分钟 |

### PDF 与 OCR 流程

1. `pdftotext` 提取整本文字层，按分页符拆页；
2. 逐页过质量闸门：空页、乱码、压缩流二进制标记判为不可读；
3. 只对不可读页做 OCR：
   - 默认使用随包 RapidOCR（PP-OCRv4，Windows 渲染 PNG → Python 识别）；
   - `ocrEngine: windows` 时用 Windows OCR；RapidOCR 不可用或失败时自动回退；
4. 按页序合并，再跑整体质量闸门；仍不可读则明确报错，不写空文件；
5. `.meta.json` 的 `pdfPages` 记录总页数/文字层页数/OCR 页数，`ocr` 记录引擎、渲染高度、失败页与错误。

## 配置

| 配置 | 默认 | 说明 |
|---|---|---|
| `corpusRoot` | 空 | 覆盖语料根；空 = `~/.dsh/corpus` |
| `promptOrder` | `9000` | 语料提示词段在 system prompt 中的顺序 |
| `maxPromptFiles` | `12` | 提示词最多列出的文件标题数 |
| `maxPromptChars` | `8000` | 提示词目录文本的最大字符数 |
| `ingestProvider` / `ingestModel` | 空 | 内置小代理模型覆盖 |
| `ingestVisionProvider` / `ingestVisionModel` | 空 | 图片识别视觉模型；留空跟随默认模型 |
| `ingestMaxChars` | `24000` | 单次摄取材料上限 |
| `ingestTimeoutMs` | `120000` | 摄取模型超时 |
| `structureMaxChars` | `48000` | 仓库/会话结构化材料上限 |
| `maxToolOutputChars` | `24000` | 工具返回值硬上限 |
| `ocrEngine` | `auto` | `auto` / `windows` / `rapidocr` |
| `ocrPython` | 空 | 覆盖随包 RapidOCR 的 `python.exe` 路径 |
| `ocrRenderHeight` | `3000` | OCR 渲染目标像素高（0 = 按 PDF DIP） |
| `ocrPageTimeoutMs` | `6000` | 逐页 OCR 预算（毫秒） |

语料根选择写入 `~/.dsh/corpus-root.json`，面板迁移会同步已有数据。

## 故障排查

| 现象 | 检查 | 处理 |
|---|---|---|
| 面板或工具看不到集合 | `corpus_access` 的 `collections` | 在右栏「语料权限」给当前工作区/会话加 grant |
| 导入报「没有导入到集合 X 的权限」 | 集合是否已存在、是否有显式 deny | 已存在集合需人工授权；新集合会自动授权并返回 `autoGranted` |
| 导入报「文件超过上限」 | 文件大小与格式 | 非 Office 文件需先拆分；Office 超 256 MiB 会自动瘦身 |
| PDF 导入报「没有可读文字层」 | 是否扫描件/加密件 | 确认 OCR 可用；加密件先解密 |
| OCR 很慢或超时 | 页数、`ocrPageTimeoutMs` | 调大逐页预算；或拆分 PDF 后分批导入 |
| 导入/重建报「已有任务在运行」 | `corpus_status` 的 `active` / `ingest.active` | 等任务结束，不要重复启动 |
| 搜不到刚导入的内容 | 集合索引是否为空、`indexedAt` | `corpus_reindex` 后重试；确认文件在 `corpus_list` 中 |
| 升级后行为没变 | DSH 是否完全重启 | 宿主半部只在进程启动时加载，刷新浏览器无效 |

## 安全

- 面板是本机管理界面，没有公网认证层，不要反向代理到公网。
- 路径解析限制在语料根内；`corpus_read` 只读语料文件。
- 删除是软删除，内容进入 `.corpus/trash/`。
- ACL 文件包含本机路径，不要提交或分享。

## 开发与发布

```powershell
# 全部本地验收
powershell -NoProfile -ExecutionPolicy Bypass -File tools\test-all.ps1

# 部署到本机插件目录
powershell -NoProfile -ExecutionPolicy Bypass -File tools\deploy.ps1

# 打完整插件包（含 OfficeCLI、pdftotext、RapidOCR 运行时）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\package-plugin.ps1
```

测试优先使用 `DSH_NODE`；未设置时自动查找 DSH 自带 Node 或 PATH 中的 `node`。真实语料回归默认跳过，设置 `CORPUS_TEST_ROOT`、`CORPUS_TEST_IT`、`CORPUS_TEST_DSH` 后运行；公式 PDF 回归可设置 `CORPUS_TEST_FORMULA_PDF`。

发布流程：更新版本 → 全部测试 → 打包 → 提交并打 tag → 发布 GitHub Release（资产为 zip、`RELEASE.md`、`SHA256SUMS`）。Release 发布后 GitHub Actions 会自动发布 npm。

## 文档

- [plugin/README.md](plugin/README.md) — 详细使用与开发说明（含 HTTP API）
- [plugin/MODEL_GUIDE.md](plugin/MODEL_GUIDE.md) — 给模型看的操作指南
- [INSTALL.md](INSTALL.md) — 安装、升级、卸载
- [LEARNING.md](LEARNING.md) — 架构、调用链与阅读顺序
- [CHANGELOG.md](CHANGELOG.md) — 版本变化
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) — 第三方组件与许可证

## 许可证

项目源码采用 **GPL-2.0-or-later**。

随包组件：OfficeCLI（Apache-2.0）、Poppler `pdftotext`（GPL-2.0-or-later）、RapidOCR 运行时（CPython、ONNX Runtime、OpenCV、NumPy 等，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）。官方 Release 只发布完整包，并附许可证与源码说明。
