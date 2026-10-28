# dsh-plugin-corpus

面向 **DeepSeek Harness（DSH）** 的文件语料库插件。

它把参考文档保存在一个可整体搬迁的语料根目录里，用 SQLite 建立索引，向模型提供检索/读取工具，支持常见文档和图片导入，并提供 Web 面板用于导入、浏览、权限管理、根目录迁移和软删除。

当前版本：**1.0.0**。这是一个 DSH 插件，不是独立应用：安装到 DSH 插件目录并完全重启 DSH 后生效。

## 功能

- **文件即语料**：每个集合是一级目录，整个语料根可复制、备份或迁移。
- **每个集合一份 SQLite 索引**：可增量/全量重建；索引可随时从文件重新生成。
- **11 个模型工具**：检索、读取、列表、重建、状态、导入、摄取、仓库/内容结构化、会话总结、删除、权限检查。
- **批量导入**：浏览器一次选择多个文件；本机路径支持多行文件/目录，目录递归扫描；同一批全部进入同一个集合。
- **公式保留**：HTML MathML、Word/PowerPoint 内嵌 OMML、常见 Unicode 数学符号和已有 LaTeX 统一规范成 `$...$` / `$$...$$`；PDF 的公式行也会保留并尽可能转成 LaTeX 公式块。
- **文档导入**：Markdown、纯文本、HTML、CSV、PDF、DOCX、XLSX、PPTX 和常见图片；每次导入只写 `processed/`（供模型读）；源文件由用户自行管理。
- **集合名**：支持中文、字母、数字、空格和常用符号（≤64 字符）；不能含 `/ \ : * ? " < > |`，也不能以点或空格结尾。
- **内置小代理**：固定提示词、单轮后台调用，不污染主会话；明确要求公式输出 LaTeX。
- **主会话接口**：把克隆的仓库或当前会话总结成语料。
- **Web 面板**：左侧栏语料库页面（导入、检索、文件列表、集合折叠、删除、根目录设置）；检索只负责定位，查看直接用外部软件；文件列表每行提供外部打开按钮。
- **外部查看**：每行「用外部软件打开」优先用插件按扩展名记住的应用；点 `▾ → 选择软件打开` 首次选择后会记住，之后主按钮直接打开；没有记录时使用 Windows 默认关联/「打开方式」。
- **Windows 辅助能力**：内置 OCR，可选 OfficeCLI/pdftotext。

## 环境要求

- Windows 10/11（OCR 依赖 Windows 能力）
- 已安装并可用的 DeepSeek Harness
- Node.js 24（或 DSH 自带 Node）
- PowerShell 5.1（Windows 脚本和打包）

插件核心是 Node.js；面板运行在 DSH Web GUI 中。

## 安装

### 使用 Release 包

1. 从 GitHub Releases 下载 `dsh-plugin-corpus-v<版本>-plugin.zip`。完整包已包含 OfficeCLI 和 pdftotext 及许可证。
2. 解压到 `%USERPROFILE%\.dsh\plugins\`，得到：
   ```
   %USERPROFILE%\.dsh\plugins\dsh-plugin-corpus\
   ```
3. 确认 DSH profile 的 `dependencies` 和 `dsh.profile.bundles` 都包含 `dsh-plugin-corpus`（使用插件管理器安装时通常会自动完成）。
4. **完全退出并重启 DSH**。只刷新浏览器页面不够，宿主半部只在进程启动时加载。

默认语料根为 `%USERPROFILE%\.dsh\corpus`，可在面板「语料库根目录」中修改或迁移。

详细步骤（含 profile 注册、升级、卸载）见 [`INSTALL.md`](INSTALL.md)。

### 从源码安装

GitHub 源码仓库不包含第三方二进制（`officecli.exe` / `pdftotext.exe`，已被 `.gitignore` 排除）。源码 clone 适合看代码和跑测试，**不是完整安装**。需要完整安装时请使用 Release 包；如果从源码开发，先把缺失文件放回 `plugin/vendor/` 再部署。

```powershell
git clone https://github.com/czdcm/dsh-plugin-corpus.git
cd dsh-plugin-corpus
powershell -NoProfile -ExecutionPolicy Bypass -File tools\deploy.ps1
# 完全重启 DSH
```

`tools\deploy.ps1` 会把 `plugin/` 复制到 `%USERPROFILE%\.dsh\plugins\dsh-plugin-corpus`。如果 vendor 二进制缺失，脚本会给出警告并安装纯 JS/Windows OCR 降级版本。

## 快速开始

1. 打开 DSH，点击左侧栏 **语料库**。
2. 选择文件（可多选）或填写多行本机路径，指定一个集合；留空会自动创建 `import-日期-时间` 集合。
3. 用 `corpus_search` / `corpus_read` 查询语料。
4. 在右侧栏 **语料权限** 给工作区或会话授权集合。
5. 手动改文件后，用面板或 `corpus_reindex` 重建索引。

## 数据布局

```text
<语料根>/
├─ <集合>/
│  ├─ <子目录>/         可选，可继续嵌套，形成树状目录
│  └─ <导入文件夹>/
│     ├─ processed/     模型使用的 Markdown（含 LaTeX 公式）
│     └─ .meta.json
└─ .corpus/
   ├─ index/<集合>.sqlite
   ├─ config.json
   ├─ thumbs/
   ├─ import-tmp/
   └─ trash/            软删除内容，可手动恢复
```

模型只检索/读取 `processed/`；插件不再保存或提供源文件。集合内部可以像文件系统一样建子目录并继续嵌套，文件列表会按目录分组显示。

## 工具

| 工具 | 用途 |
|---|---|
| `corpus_search` | 在可访问集合中检索 |
| `corpus_read` | 按路径和行范围读取 processed 文档 |
| `corpus_list` | 列出集合和文档 |
| `corpus_reindex` | 启动增量/全量重建 |
| `corpus_status` | 查看重建/导入任务、索引状态、访问范围 |
| `corpus_import` | 导入本机文件或上传文件 |
| `corpus_ingest` | 后台提取并导入文档 |
| `corpus_structure` | 把仓库/目录/文件/文本总结为结构化语料 |
| `corpus_summarize_session` | 把会话总结成语料 |
| `corpus_delete` | 软删除单篇或整个集合 |
| `corpus_access` | 解释当前工作区/会话权限 |

所有写操作都经过 ACL。

## HTTP API

面板使用同源路由，前缀为 `/api/dsh-plugin-corpus/`：

```text
GET  /overview          GET  /files             POST /search
POST /read              POST /reindex           GET  /status
GET  /access            GET  /import/targets    POST /import
GET  /import/status     POST /delete            GET  /gallery
GET  /settings          POST /settings/root     POST /settings/open
GET  /openers            POST /open-external
GET/POST /policy
```

这些接口只服务于本机 DSH 面板，不要暴露到公网。

## 权限

默认拒绝。授权文件位于 `%USERPROFILE%\.dsh\corpus-access.json`，可按 workspace/session 授权，路径支持集合名、前缀和 glob；显式 `deny` 优先，过期授权忽略。

本机 ACL 文件不提交到仓库；使用 `config/corpus-access.example.json` 作为模板。

## 配置

| 配置 | 默认 | 说明 |
|---|---|---|
| `corpusRoot` | 空 | 覆盖语料根；空表示 `~/.dsh/corpus` |
| `promptOrder` | `9000` | 语料提示词段顺序 |
| `maxPromptFiles` | `12` | 提示词最多列出的文件标题数 |
| `ingestProvider` / `ingestModel` | 空 | 内置小代理模型覆盖 |
| `ingestVisionProvider` / `ingestVisionModel` | 空 | 图片识别使用的视觉模型；留空跟随默认模型 |
| `ingestMaxChars` | `24000` | 单次摄取材料上限 |
| `ingestTimeoutMs` | `120000` | 摄取模型超时 |
| `structureMaxChars` | `48000` | 仓库/会话结构化材料上限 |

语料根也可从面板修改，选择会写入 `~/.dsh/corpus-root.json`，并支持迁移已有数据。

## 安全

- 面板是本地管理界面，没有公网认证层；只监听本机。
- 路径解析限制在语料根内。
- 删除是软删除，进入 `.corpus/trash/` 可手动恢复。
- 本机 ACL 文件不要提交或分享。

## 开发

```powershell
# 全部本地验收
powershell -NoProfile -ExecutionPolicy Bypass -File tools\test-all.ps1

# 部署到本机插件目录并重启 DSH
powershell -NoProfile -ExecutionPolicy Bypass -File tools\deploy.ps1

# 打完整插件包（默认写入项目 releases/v<版本>/）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\package-plugin.ps1

# 打不含 GPL pdftotext 的版本
powershell -NoProfile -ExecutionPolicy Bypass -File tools\package-plugin.ps1 -WithoutPdftotext
```

测试优先使用 `DSH_NODE`；未设置时自动查找 DSH 自带 Node 或 PATH 中的 `node`。真实语料回归测试默认跳过，设置 `CORPUS_TEST_ROOT`、`CORPUS_TEST_IT`、`CORPUS_TEST_DSH` 后运行；公式 PDF 回归可设置 `CORPUS_TEST_FORMULA_PDF`。

## 仓库结构

```text
plugin/          DSH 插件：宿主 lib/、客户端 bundle、vendor/、详细 README
tests/           自包含 Node .mjs 测试
tools/           部署/测试/打包 PowerShell 脚本
config/          示例配置；本机 ACL 文件已忽略
LEARNING.md      架构和阅读指南
CHANGELOG.md     对外版本说明
THIRD_PARTY_NOTICES.md
LICENSE
```

## 文档

- [`plugin/README.md`](plugin/README.md) — 详细使用与开发说明
- [`INSTALL.md`](INSTALL.md) — 安装、升级、卸载
- [`LEARNING.md`](LEARNING.md) — 架构、调用链、阅读顺序
- [`CHANGELOG.md`](CHANGELOG.md) — 版本变化
- [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) — 第三方组件与许可证
- [`LICENSE`](LICENSE) — GPL-2.0-or-later

## 许可证

本项目源码采用 **GPL-2.0-or-later**。

OfficeCLI 为 Apache-2.0；Poppler/pdftotext 为 GPL-2.0-or-later。完整插件包包含两者及许可证和源码说明；`WithoutPdftotext` 版本不包含 pdftotext 二进制。详见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
