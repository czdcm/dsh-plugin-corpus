# dsh-plugin-corpus（插件使用与开发说明）

dsh-plugin-corpus 是 **DeepSeek Harness (DSH)** 的文件语料库插件。

它的核心思想很简单：

- **内容是普通文件**：语料根目录可以整体搬走、备份；
- **索引只是缓存**：每个集合一份 SQLite，可以随时重建；
- **模型只读 `processed/`**：插件不再保存源文件；
- **一切访问先过 ACL**：按工作区/会话/路径授权，默认拒绝。

当前版本：**1.3.1**。

---

## 1. 安装与启用

### 从 Release 安装

1. 下载 `dsh-plugin-corpus-v<version>-plugin.zip`；
2. 解压到 `%USERPROFILE%\.dsh\plugins\`，得到：
   ```
   %USERPROFILE%\.dsh\plugins\dsh-plugin-corpus\
   ```
3. 确认 DSH profile 的 `dependencies` 和 `dsh.profile.bundles` 都包含
   `dsh-plugin-corpus`（通过插件管理器安装时通常会自动完成）；
4. **完全重启 DSH**。宿主半部（工具、提示词、面板路由、提取器）和客户端
   bundle 都只在进程启动时加载，刷新浏览器不够。

默认语料根：

```
%USERPROFILE%\.dsh\corpus
```

可以在面板的 **语料库根目录** 设置中修改或迁移。

### 从源码部署

```powershell
git clone https://github.com/czdcm/dsh-plugin-corpus.git
cd dsh-plugin-corpus
powershell -NoProfile -ExecutionPolicy Bypass -File tools\deploy.ps1
# 完全重启 DSH
```

`tools\deploy.ps1` 会把 `plugin/` 复制到 DSH 插件目录。GitHub 源码 clone 不含 vendor 二进制；完整安装请用 Release 包，源码开发前先把 vendor 文件放回 `plugin/vendor/`，否则脚本会提示降级。

---

## 2. 界面与日常使用

### 左侧栏「语料库」

- **导入语料**：浏览器文件可多选；本机路径可多行输入（每行一个文件/目录），同一批全部导入同一个集合；集合留空会自动创建 `import-日期-时间`；集合名支持中文、空格和常用符号（≤64 字符，不能含 `/ \ : * ? " < > |`）；
- **公式**：HTML MathML、Word/PowerPoint OMML、Unicode 数学符号和已有 LaTeX 会统一整理为 `$...$` / `$$...$$`；PDF 公式行也会保留为 LaTeX 公式块（插图不要求识别）；
- **检索**：按关键词搜索已索引的 `processed/` 内容；结果只用于定位，不直接打开预览；
- **查看**：文件列表每行的「用外部软件打开」主按钮优先读取 Windows 默认关联直接打开；没有关联时打开系统软件选择器，由 Windows 记录本次选择；`▾` 可再次打开系统软件选择器；文件列表的图标/名称/类型跟随处理后语料类型，按钮只显示默认应用图标，右侧箭头保留系统选择器；不再内置右侧栏预览；
- **语料文件**：按集合分组的资源管理器式列表；
  - 集合组默认折叠，点集合标题 `▸`/`▾` 展开或折叠；
  - 顶部有「全部展开 / 全部折叠」；
  - 每行显示图标、名称、类型、大小、导入时间、操作；
  - 行尾「删除」是两击确认的软删除；
- **重建**：增量/全量重建索引；
- **根目录设置**：查看、复制、打开、迁移语料根。

### 右侧栏「语料权限」

- 查看当前会话/工作区实际能访问哪些集合；
- 编辑策略：默认拒绝，按 workspace/session 授权，可设置过期时间；
- 保存前自动备份原策略。

### 主会话工具

模型可以通过 13 个工具使用语料库：

| 工具 | 用途 |
|---|---|
| `corpus_search` | 在可访问集合中检索 |
| `corpus_read` | 按路径和行范围读取 processed 文档 |
| `corpus_list` | 列出集合与文档 |
| `corpus_catalog` | 返回集合/文档卡片、行数、章节目录摘要 |
| `corpus_outline` | 返回章节/小节标题、起止行号、摘要；缺失目录时按需生成 |
| `corpus_reindex` | 启动增量/全量重建 |
| `corpus_status` | 查看重建/导入任务、索引状态、访问范围 |
| `corpus_import` | 导入本机文件或已上传文件 |
| `corpus_ingest` | 后台提取并导入文档 |
| `corpus_structure` | 把仓库/目录/文件/文本总结为结构化语料 |
| `corpus_summarize_session` | 把会话总结成语料 |
| `corpus_delete` | 软删除单篇或整个集合 |
| `corpus_access` | 解释当前工作区/会话的权限范围 |

---

## 3. 数据布局

```
<CORPUS_ROOT>/
├─ <collection>/
│  ├─ <subfolder>/      可选，可继续嵌套，形成树状目录
│  └─ <import-folder>/
│     ├─ processed/     模型使用的 Markdown
│     └─ .meta.json
└─ .corpus/
   ├─ index/<collection>.sqlite
   ├─ config.json
   ├─ outlines/<hash>.json  文档结构目录（不进入检索分块）
   ├─ thumbs/
   ├─ import-tmp/
   └─ trash/<时间>/     软删除内容，可手动恢复
```

每次导入都有自己的文件夹，方便整体删除或迁移；集合内部也可以建子目录并继续嵌套，文件列表按目录分组。

索引表很轻：

- `docs`：文档路径、标题、大小、mtime、hash、块数；
- `chunks`：块文本、标题、行号范围；
- `meta`：`indexed_at` 等元数据。

删除索引不会丢语料；重新 `corpus_reindex` 即可重建。

---

## 4. 支持的文件格式

| 格式 | 提取方式 |
|---|---|
| `.md` `.markdown` `.mdx` `.txt` `.rst` `.text` | 直接读取文本 |
| `.html` `.htm` | 去标签，保留标题/段落/列表 |
| `.csv` | 文本化表格 |
| `.pdf` | 优先随包 `pdftotext`；无文字层时用纯 JS 解析；扫描版走 Windows OCR |
| `.docx` `.xlsx` `.pptx` | 优先 OfficeCLI；失败/缺失时回退纯 JS ZIP+XML 解析 |
| 图片（PNG/JPEG/WebP/GIF/BMP/TIFF） | 有可用视觉模型时结构化；否则保存占位 Markdown |

面板里的 **Vision** 不可用时会显示具体原因，通常是当前默认模型不支持图片输入。可以在 DSH profile 的插件配置中设置 `ingestVisionProvider` / `ingestVisionModel` 指向可接收图片的模型；未配置视觉模型时图片退回内置 Windows OCR。

PDF/Office 的随包工具是可选增强；缺失时插件仍能用纯 JS/系统能力降级运行。
OfficeCLI 是 Apache-2.0；Poppler `pdftotext` 是 GPL-2.0-or-later，详见仓库根目录的
`THIRD_PARTY_NOTICES.md`。

---

## 5. 访问控制（ACL）

策略文件默认位置：

```
%USERPROFILE%\.dsh\corpus-access.json
```

结构示例：

```json
{
  "version": 1,
  "default": "deny",
  "grants": [
    {
      "workspace": "C:/Users/<you>/work/project-a",
      "paths": ["collection-a"]
    },
    {
      "session": "session-id",
      "paths": ["collection-b/guides", "collection-b/reference.md"],
      "expiresAt": "2027-01-01T00:00:00.000Z"
    }
  ],
  "deny": []
}
```

规则：

- 默认拒绝；`grants` 按 workspace/session + 路径匹配；
- 显式 `deny` 优先于 `grants`；
- 过期的 grant 自动忽略；
- 集合名、路径前缀、glob 都可以作为 `paths`；
- 工具调用、提示词列表、面板 `/access` 使用同一套判断。

仓库中的 `config/corpus-access.example.json` 是脱敏模板；本机 ACL 文件不要提交。

---

## 6. 配置项

插件配置（DSH profile 中）：

| 配置 | 默认 | 说明 |
|---|---|---|
| `corpusRoot` | 空 | 覆盖语料根；空 = `~/.dsh/corpus` |
| `promptOrder` | `9000` | 语料提示词段在 system prompt 中的顺序 |
| `maxPromptFiles` | `12` | 提示词里最多列多少个文件标题 |
| `ingestProvider` / `ingestModel` | 空 | 内置小代理使用的模型覆盖 |
| `ingestVisionProvider` / `ingestVisionModel` | 空 | 图片识别使用的视觉模型；留空跟随默认模型 |
| `ingestMaxChars` | `24000` | 单次 ingest 的材料上限 |
| `ingestTimeoutMs` | `120000` | ingest LLM 超时 |
| `structureMaxChars` | `48000` | 仓库/会话结构化的材料上限 |

---

## 7. 面板 HTTP API

面板使用同源路由，前缀：

```
/api/dsh-plugin-corpus
```

路由列表：

```text
GET  /overview          GET  /files             POST /search
POST /read              POST /reindex           GET  /status
GET  /access            GET  /import/targets    POST /import
GET  /import/status     POST /delete            GET  /gallery
GET  /settings          POST /settings/root     POST /settings/open
GET  /settings          POST /settings/root     POST /settings/open
GET  /app-icon
POST /open-external
GET/POST /policy
```

这些接口服务于本机 DSH 面板，不应暴露到公网。

### 常用请求示例

```powershell
# 概览
Invoke-RestMethod http://127.0.0.1:<port>/api/dsh-plugin-corpus/overview

# 搜索（POST JSON）
Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:<port>/api/dsh-plugin-corpus/search `
  -ContentType 'application/json' `
  -Body '{"query":"search terms","limit":8}'

# 文件列表
Invoke-RestMethod 'http://127.0.0.1:<port>/api/dsh-plugin-corpus/gallery?limit=100'
```

实际端口以 DSH 启动时为准。

---

## 8. 限制与安全

- 面板是本地管理界面，没有面向公网的认证；不要反向代理到公网；
- `corpus_read` 只读 `processed/`；
- 删除是软删除，内容移到 `.corpus/trash/`；
- 文档导入有单文件大小限制（默认 25 MiB）和格式白名单；
- 扫描版 PDF 的 OCR 依赖 Windows OCR，速度比文字层提取慢；
- 访问策略文件、本机 ACL 配置不要提交到 Git。

---

## 9. 开发

```powershell
# 运行全部本地验收
powershell -NoProfile -ExecutionPolicy Bypass -File tools\test-all.ps1

# 部署到 ~/.dsh/plugins/dsh-plugin-corpus
powershell -NoProfile -ExecutionPolicy Bypass -File tools\deploy.ps1

# 打完整插件包
powershell -NoProfile -ExecutionPolicy Bypass -File tools\package-plugin.ps1

# 打不含 GPL pdftotext 的插件包
powershell -NoProfile -ExecutionPolicy Bypass -File tools\package-plugin.ps1 -WithoutPdftotext
```

测试使用 Node 自带模块和手写断言；`tools/test-all.ps1` 优先使用 `DSH_NODE`，
否则自动查找 DSH 自带 Node 或 PATH 中的 `node`。

真实语料回归测试默认跳过；需要时设置：

```powershell
$env:CORPUS_TEST_ROOT = '...'
$env:CORPUS_TEST_IT = '...'
$env:CORPUS_TEST_DSH = '...'
```

更多架构说明见仓库根目录的 `LEARNING.md`。

---

## 10. 许可证

本项目源码采用 **GPL-2.0-or-later**。

第三方组件：

- OfficeCLI：Apache-2.0；
- Poppler `pdftotext`：GPL-2.0-or-later；
- Windows OCR：调用系统 API，不再分发微软二进制。

完整说明见仓库根目录的 `THIRD_PARTY_NOTICES.md` 与 `LICENSE`。
