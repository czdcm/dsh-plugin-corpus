/**
 * dsh-plugin-corpus v1.4 — 主会话交流接口背后的「仓库/内容结构化」服务。
 *
 * 主会话（DSH agent）先按用户要求把 GitHub 仓库 clone/pull 到本地，或自己
 * 抓取一段文本，然后调用 corpus_structure 工具；本模块负责：
 *   · 扫描仓库/目录/文件/文本，生成适合单轮模型读取的摘要材料；
 *   · 调用内置摄取小代理做总结/结构化；
 *   · 按 per-import 布局写 originals/ + processed/ + .meta.json；
 *   · 触发集合重建，并把 Markdown 结果直接返回给主会话。
 *
 * 模型永远只读 processed；originals 只保留来源快照，供人查看/追溯。
 */
import fs from 'node:fs'
import path from 'node:path'
import { SUPPORTED_EXTENSIONS, extractDocument } from './extract.js'

const COLLECTION_RE = /^[A-Za-z0-9._-]{1,64}$/
const MAX_LIST_FILES = 5000
const DEFAULT_MAX_FILES = 300
const DEFAULT_MAX_CHARS = 48000
const DEFAULT_MAX_FILE_BYTES = 512 * 1024

const CODE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.pyi', '.go', '.rs', '.java', '.kt', '.kts', '.scala',
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.cs', '.fs',
  '.rb', '.php', '.swift', '.m', '.mm', '.lua', '.pl', '.r', '.jl',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.sql', '.graphql', '.gql', '.proto', '.vue', '.svelte', '.astro',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.md', '.mdx', '.txt', '.rst', '.adoc', '.tex',
  '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env.example',
  '.xml', '.plist', '.gradle', '.properties', '.lock', '.sum',
])
const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'vendor',
  'dist', 'build', 'out', 'target', 'coverage', '.next', '.nuxt', '.output',
  '.venv', 'venv', 'env', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.idea', '.vscode', '.cache', '.turbo', '.parcel-cache', '.DS_Store',
  'bin', 'obj', 'Pods', 'DerivedData', '.gradle', '.m2', 'cmake-build-debug', 'cmake-build-release',
])
const CONFIG_NAMES = new Set([
  'package.json', 'pnpm-workspace.yaml', 'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt',
  'cargo.toml', 'go.mod', 'go.sum', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle',
  'gemfile', 'composer.json', 'makefile', 'dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  'tsconfig.json', 'vite.config.js', 'vite.config.ts', 'webpack.config.js', 'rollup.config.js',
  'nuxt.config.ts', 'next.config.js', 'next.config.mjs', 'astro.config.mjs', '.gitignore', 'readme',
  'license', 'license.md', 'notice', 'changelog.md', 'contributing.md', 'agents.md',
])

const REPO_SYSTEM_PROMPT = `你是「语料库仓库分析代理」，只做仓库/项目的识别、总结和结构化，不闲聊、不调用工具、不编造原文没有的事实。
输入通常包含仓库的 Git 信息、文件清单、README、配置文件和若干源码摘录；内容可能因长度限制被截断，截断处在输入里会注明。
请输出严格 Markdown（不要用代码围栏包住整篇），尽量遵守：
# <准确的项目/仓库名>
> 来源：<仓库 URL 或路径>；<分支/commit 或文件类型>；一句话定位

## 概览
用 3-6 句话说清这是什么项目、解决什么问题、面向谁、当前完成度/状态（若原文有）。

## 目录与架构
按顶层目录/模块说明职责和关系；可用列表或简短表格。说明入口、核心包、数据流/调用链。

## 核心模块与关键文件
挑最重要的 5-12 个模块/文件，逐个说明用途、关键接口/类/函数、值得记住的实现细节；不要大段抄代码。

## 技术栈与依赖
列出语言、框架、运行时、主要依赖、构建/包管理工具。

## 构建、运行与测试
从 README/配置中提取可执行的命令；原文没写的写“原文未说明”。

## 对语料库有价值的结论
- 这个仓库最值得长期保留的知识点、可复用模式、风险/限制；没有就写“原文未说明”。

## 术语与关键词
- 5-15 个术语/关键词，必要时一句话解释。

如果某节没有材料，写“原文未说明”或省略；不要输出与项目无关的内容。`

const SESSION_SYSTEM_PROMPT = `你是「语料库会话总结代理」，负责把一次 DSH 开发会话沉淀成可长期检索的知识，不闲聊、不调用工具、不编造记录里没有的事实。
输入是一次会话的转录（用户需求、助手可见回复、工具调用/少量结果），可能被截断。
请输出严格 Markdown（不要用代码围栏包住整篇），尽量遵守：
# <会话主题>
> 会话 id / 消息数 / 一句话定位

## 会话目标与背景
用 3-6 句话说清用户想要什么、起点和约束。

## 思路演进与关键决策
按时间或主题说明走过哪些方案、为什么改方向、放弃了什么、最终为什么选当前方案；重点保留决策依据和踩过的坑。

## 完成的工作与结论
列出实际完成/验证过的事情、关键命令、文件路径、接口/配置名、测试结果；区分“已验证”和“未验证”。

## 未完成、风险与下一步
明确遗留问题、已知限制、需要重启/部署/人工确认的事项。

## 可长期保留的知识
- 3-10 条以后遇到同类任务值得直接复用的经验/模式/边界条件。

## 关键词
- 5-15 个关键词，必要时一句话解释。

记录里没有的写“记录未说明”；不要把推测写成事实。`

function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function safeName(value) {
  return String(value || 'source')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'source'
}

function slugOf(title, fallback) {
  const base = String(title || fallback || 'structured')
    .replace(/^#+\s*/, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 72)
  return base || 'structured'
}

function normalizePrefix(value) {
  const text = String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (text === '') return ''
  const parts = text.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) throw new Error('prefix 不能包含 . 或 ..')
  return parts.join('/')
}

function yamlString(value) {
  return JSON.stringify(String(value === undefined || value === null ? '' : value))
}

function stripFrontMatter(text) {
  const value = String(text || '')
  const match = value.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return match ? value.slice(match[0].length).trim() : value.trim()
}

function guessTitle(text, fallback) {
  const heading = String(text || '').match(/^#\s+(.+)$/m)
  if (heading) return heading[1].trim().slice(0, 160)
  const first = String(text || '').split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '')
  if (first) return first.replace(/^#+\s*/, '').slice(0, 160)
  return fallback
}

function isTextCandidate(name, ext) {
  const lower = String(name || '').toLowerCase()
  if (CONFIG_NAMES.has(lower)) return true
  if (lower.startsWith('readme') || lower.startsWith('license')) return true
  return CODE_EXT.has(String(ext || '').toLowerCase())
}

function readText(file, maxBytes) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > maxBytes) return null
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function readGitInfo(dir) {
  const gitDir = path.join(dir, '.git')
  let stat = null
  try { stat = fs.statSync(gitDir) } catch { return null }
  if (!stat.isDirectory()) return null
  const info = { remote: '', branch: '', commit: '' }
  try {
    const config = fs.readFileSync(path.join(gitDir, 'config'), 'utf8')
    const remoteMatch = config.match(/\[remote\s+"origin"\][\s\S]*?^\s*url\s*=\s*(.+)$/m)
    if (remoteMatch) info.remote = remoteMatch[1].trim()
  } catch { /* 没有 remote */ }
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5).trim()
      info.branch = ref.replace(/^refs\/heads\//, '')
      try {
        info.commit = fs.readFileSync(path.join(gitDir, ref), 'utf8').trim()
      } catch {
        // clone 后 git pack-refs / gc 会把 loose ref 收进 packed-refs。
        try {
          const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8')
          const line = packed.split(/\r?\n/).find((row) => row.trim().endsWith(` ${ref}`))
          if (line) info.commit = line.trim().split(/\s+/)[0]
        } catch { info.commit = '' }
      }
    } else {
      info.branch = '(detached)'
      info.commit = head
    }
  } catch { /* 没有 HEAD */ }
  return info
}

function scanRepo(dir, options) {
  const maxFiles = Math.max(1, Number(options.maxFiles) || DEFAULT_MAX_FILES)
  const maxFileBytes = Math.max(1024, Number(options.maxFileBytes) || DEFAULT_MAX_FILE_BYTES)
  const files = []
  let skipped = 0
  let truncated = false
  const walk = (current, rel, depth) => {
    if (depth > 16 || files.length >= MAX_LIST_FILES) { truncated = true; return }
    let entries = []
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (files.length >= MAX_LIST_FILES) { truncated = true; return }
      if (entry.name.startsWith('.')) continue
      const abs = path.join(current, entry.name)
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) { skipped += 1; continue }
        walk(abs, relPath, depth + 1)
        continue
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      if (entry.isSymbolicLink()) { skipped += 1; continue }
      const ext = path.extname(entry.name).toLowerCase()
      if (!isTextCandidate(entry.name, ext)) { skipped += 1; continue }
      let size = 0
      try { size = fs.statSync(abs).size } catch { continue }
      files.push({ rel: relPath, abs, name: entry.name, ext, size, depth })
    }
  }
  walk(dir, '', 0)
  files.sort((left, right) => left.depth - right.depth || left.rel.localeCompare(right.rel))
  return { files, skipped, truncated, maxFiles, maxFileBytes, dir }
}

function countByExt(files) {
  const counts = new Map()
  for (const file of files) counts.set(file.ext || '(none)', (counts.get(file.ext || '(none)') || 0) + 1)
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 12)
}

function buildRepoDigest(scan, options) {
  const maxChars = Math.max(4000, Number(options.maxChars) || DEFAULT_MAX_CHARS)
  const maxFiles = Math.max(1, Number(options.maxFiles) || DEFAULT_MAX_FILES)
  const warnings = []
  const git = readGitInfo(scan.dir)
  const totalBytes = scan.files.reduce((sum, file) => sum + file.size, 0)
  const lines = [
    `项目目录：${scan.dir}`,
    git && git.remote ? `Git remote：${git.remote}` : 'Git remote：原文未说明',
    git && git.branch ? `Git 分支：${git.branch}` : '',
    git && git.commit ? `Git commit：${git.commit}` : '',
    `文件数量：${scan.files.length}（另有 ${scan.skipped} 个文件/目录因二进制/忽略规则跳过）`,
    `文件总大小：${totalBytes} 字节`,
    `文件类型统计：${countByExt(scan.files).map(([ext, count]) => `${ext}:${count}`).join('，') || '无'}`,
    '',
    '文件清单（最多 240 条）：',
    ...scan.files.slice(0, 240).map((file) => `- ${file.rel} (${file.size} B)`),
  ]
  if (scan.files.length > 240) lines.push(`- …其余 ${scan.files.length - 240} 个文件省略`)
  lines.push('', '--- 文件内容摘录 ---', '')

  const added = new Set()
  const addFile = (file, perFileLimit) => {
    if (!file || added.has(file.rel)) return false
    const text = readText(file.abs, scan.maxFileBytes)
    if (text === null) return false
    const clipped = text.length > perFileLimit ? text.slice(0, perFileLimit) + '\n…[文件已截断]' : text
    const block = `\n--- FILE: ${file.rel} (${file.size} B) ---\n${clipped}\n`
    if (lines.join('\n').length + block.length > maxChars) return false
    lines.push(block.trimEnd(), '')
    added.add(file.rel)
    return true
  }

  const isReadme = (file) => /^readme(\.|$)/i.test(file.name) || /(^|\/)readme\.md$/i.test(file.rel)
  const readmes = scan.files.filter(isReadme).sort((left, right) => left.depth - right.depth)
  for (const file of readmes.slice(0, 4)) addFile(file, 12000)
  const configs = scan.files.filter((file) => CONFIG_NAMES.has(file.name.toLowerCase()) && !isReadme(file))
  for (const file of configs.slice(0, 10)) addFile(file, 4000)
  const docs = scan.files.filter((file) => ['.md', '.mdx', '.rst', '.txt', '.adoc'].includes(file.ext) && !added.has(file.rel))
    .sort((left, right) => left.depth - right.depth)
  for (const file of docs.slice(0, 12)) addFile(file, 5000)
  const priority = (file) => {
    let score = 0
    if (/(^|\/)(src|lib|app|packages|cmd|internal|core|server|client)\//i.test(file.rel)) score += 4
    if (/(^|\/)(test|tests|spec|__tests__)\//i.test(file.rel)) score -= 2
    if (/(^|\/)(index|main|app|server|cli|entry)\./i.test(file.rel)) score += 3
    score -= file.depth
    if (file.size < 200) score -= 1
    return score
  }
  const sources = scan.files
    .filter((file) => CODE_EXT.has(file.ext) && !added.has(file.rel) && !['.md', '.mdx', '.txt', '.rst', '.adoc'].includes(file.ext))
    .sort((left, right) => priority(right) - priority(left))
  for (const file of sources) {
    if (added.size >= maxFiles) { warnings.push(`源码摘录达到 maxFiles=${maxFiles}，其余文件未纳入本次总结`); break }
    addFile(file, 3500)
  }
  if (added.size < scan.files.length) warnings.push(`输入材料共 ${scan.files.length} 个文件，本次实际读入 ${added.size} 个（受 maxFiles/maxChars 限制）`)
  if (scan.truncated) warnings.push('文件清单超过扫描上限，已截断')
  let digest = lines.join('\n')
  if (digest.length > maxChars) digest = digest.slice(0, maxChars) + `\n\n[注意：仓库摘要材料共 ${digest.length} 字，已截断到前 ${maxChars} 字]`
  return { digest, git, stats: { files: scan.files.length, included: added.size, totalBytes, skipped: scan.skipped }, warnings }
}

function buildFileDigest(file, extracted, options) {
  const maxChars = Math.max(4000, Number(options.maxChars) || DEFAULT_MAX_CHARS)
  const warnings = Array.isArray(extracted.warnings) ? extracted.warnings.slice() : []
  const text = String(extracted.text || '')
  const clipped = text.length > maxChars ? text.slice(0, maxChars) + `\n\n[注意：原文共 ${text.length} 字，已截断到前 ${maxChars} 字]` : text
  return {
    digest: `文件：${file}\n格式：${extracted.format}\n\n--- 内容 ---\n${clipped}`,
    git: null,
    stats: { files: 1, included: 1, totalBytes: fs.existsSync(file) ? fs.statSync(file).size : text.length, skipped: 0 },
    warnings,
  }
}

function frontMatter({ title, source, kind, collection, importedAt, original, instructions, aiStructured, stats, sessionId, git }) {
  const lines = [
    '---',
    `title: ${yamlString(title)}`,
    `source: ${yamlString(source)}`,
    `kind: ${yamlString(kind)}`,
    `format: ${yamlString(kind === 'repo' ? 'repository' : kind)}`,
    `importedAt: ${yamlString(importedAt)}`,
    `collection: ${yamlString(collection)}`,
    `aiStructured: ${aiStructured ? 'true' : 'false'}`,
  ]
  if (original) lines.push(`original: ${yamlString(original)}`)
  if (sessionId) lines.push(`sessionId: ${yamlString(sessionId)}`)
  if (git && git.remote) lines.push(`gitRemote: ${yamlString(git.remote)}`)
  if (git && git.branch) lines.push(`gitBranch: ${yamlString(git.branch)}`)
  if (git && git.commit) lines.push(`gitCommit: ${yamlString(git.commit)}`)
  if (instructions) lines.push(`instructions: ${yamlString(instructions)}`)
  if (stats) lines.push(`stats: ${yamlString(JSON.stringify(stats))}`)
  lines.push('---', '')
  return lines.join('\n')
}

/**
 * @param opts.root - 语料根。
 * @param opts.agent - createIngestAgent 的返回值。
 * @param opts.config - 插件配置。
 * @param opts.reindex - job runner（可选）。
 * @param opts.log - 日志函数（可选）。
 */
export function createStructureService({ root, agent, config, log, reindex }) {
  async function run(options = {}) {
    const shouldImport = options.import !== false
    const collection = String(options.collection || '').trim()
    if (shouldImport && (collection === '' || !COLLECTION_RE.test(collection))) {
      throw new Error('导入语料时 collection 必须是合法集合名（字母/数字/._-，≤64）')
    }
    if (!shouldImport && collection !== '' && !COLLECTION_RE.test(collection)) {
      throw new Error('collection 必须是合法集合名（字母/数字/._-，≤64）')
    }
    const prefix = normalizePrefix(options.prefix)
    const instructions = typeof options.instructions === 'string' ? options.instructions.trim() : ''
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : ''
    const maxFiles = Math.max(1, Math.min(2000, Number(options.maxFiles) || DEFAULT_MAX_FILES))
    const maxChars = Math.max(4000, Math.min(160000, Number(options.maxChars) || Number(config.structureMaxChars) || DEFAULT_MAX_CHARS))
    const shouldReindex = options.reindex !== false
    if (!agent || typeof agent.available !== 'function' || !agent.available()) {
      throw new Error('内置小代理不可用（没有可用的默认模型或 LLM 服务）')
    }

    const sourcePath = typeof options.path === 'string' ? options.path.trim() : ''
    const sourceText = typeof options.text === 'string' ? options.text : ''
    if (sourcePath === '' && sourceText === '') throw new Error('必须提供 path 或 text 之一')
    if (sourcePath !== '' && sourceText !== '') throw new Error('path 与 text 只能二选一')

    let kind = 'text'
    let sourceLabel = 'inline text'
    let title = typeof options.title === 'string' ? options.title.trim() : ''
    let digest = ''
    let git = null
    let stats = null
    let warnings = []
    let originalCopy = null
    let repoScan = null

    if (sourceText !== '') {
      kind = options.kind === 'session' ? 'session' : 'text'
      sourceLabel = typeof options.sourceLabel === 'string' && options.sourceLabel.trim() !== ''
        ? options.sourceLabel.trim()
        : (kind === 'session' ? 'session transcript' : '主会话提供文本')
      digest = sourceText
      stats = { chars: sourceText.length, files: 0, included: 0, totalBytes: Buffer.byteLength(sourceText, 'utf8'), skipped: 0 }
      if (!title) title = kind === 'session' ? `会话总结 ${new Date().toISOString().slice(0, 10)}` : guessTitle(sourceText, '主会话文本')
    } else {
      const resolved = path.resolve(sourcePath)
      let stat
      try { stat = fs.lstatSync(resolved) } catch { throw new Error(`path 不存在：${resolved}`) }
      if (stat.isSymbolicLink()) throw new Error('不接受符号链接')
      if (stat.isDirectory()) {
        kind = 'repo'
        sourceLabel = resolved
        repoScan = scanRepo(resolved, { maxFiles, maxFileBytes: options.maxFileBytes })
        const built = buildRepoDigest(repoScan, { maxFiles, maxChars })
        digest = built.digest
        git = built.git
        stats = built.stats
        warnings = built.warnings
        if (!title) title = path.basename(resolved)
      } else if (stat.isFile()) {
        kind = 'file'
        sourceLabel = resolved
        let extracted = null
        const ext = path.extname(resolved).toLowerCase()
        if (SUPPORTED_EXTENSIONS.includes(ext)) {
          extracted = await extractDocument(resolved)
        } else {
          const text = readText(resolved, Math.max(1024, Number(options.maxFileBytes) || DEFAULT_MAX_FILE_BYTES))
          if (text === null) throw new Error(`无法作为文本读取：${resolved}`)
          extracted = { ok: true, kind: 'text', format: ext.slice(1) || 'text', text, title: path.basename(resolved, ext), warnings: [] }
        }
        const built = buildFileDigest(resolved, extracted, { maxChars })
        digest = built.digest
        stats = built.stats
        warnings = built.warnings
        if (!title) title = extracted.title || path.basename(resolved, ext)
      } else {
        throw new Error('path 必须是文件或目录')
      }
    }

    const system = kind === 'repo' ? REPO_SYSTEM_PROMPT : (kind === 'session' ? SESSION_SYSTEM_PROMPT : undefined)
    if (log) log('info', `corpus_structure：${kind}，输入 ${digest.length} 字，模型 ${agent.route ? JSON.stringify(agent.route()) : 'default'}`)
    const body = await agent.structure({
      text: digest,
      meta: { title, source: sourceLabel, format: kind, collection, warnings, instructions },
      instructions,
      system,
      maxChars: Math.max(maxChars, Math.min(160000, digest.length + 4000)),
      maxTokens: 4096,
    })
    const cleanBody = stripFrontMatter(body)
    if (!title || title === path.basename(sourceLabel)) title = guessTitle(cleanBody, title || '结构化结果')
    const finalTitle = String(title || '结构化结果').slice(0, 160)
    const importedAt = new Date().toISOString()

    if (!shouldImport) {
      return { ok: true, imported: false, kind, title: finalTitle, source: sourceLabel, body: cleanBody, stats, warnings, git }
    }

    const collectionDir = path.resolve(root, collection)
    const parentDir = prefix === '' ? collectionDir : path.join(collectionDir, prefix)
    const base = `${stamp()}-${slugOf(finalTitle, kind === 'repo' ? path.basename(sourceLabel) : 'structured')}`
    let folderName = base
    let counter = 2
    while (fs.existsSync(path.join(parentDir, folderName))) {
      folderName = `${base}-${counter}`
      counter += 1
    }
    const folderRel = path.posix.join(collection, prefix === '' ? folderName : `${prefix}/${folderName}`)
    const folderAbs = path.join(root, ...folderRel.split('/'))
    const originalsDir = path.join(folderAbs, 'originals')
    const processedDir = path.join(folderAbs, 'processed')
    fs.mkdirSync(originalsDir, { recursive: true })
    fs.mkdirSync(processedDir, { recursive: true })

    if (kind === 'repo') {
      const manifest = {
        kind: 'repository',
        sourcePath: sourceLabel,
        git,
        scannedAt: importedAt,
        totalFiles: repoScan ? repoScan.files.length : 0,
        stats,
        files: repoScan ? repoScan.files.slice(0, MAX_LIST_FILES).map((file) => ({ path: file.rel, bytes: file.size })) : [],
      }
      fs.writeFileSync(path.join(originalsDir, 'repo.json'), JSON.stringify(manifest, null, 2), 'utf8')
      const readme = repoScan ? repoScan.files.find((file) => /^readme(\.|$)/i.test(file.name) && file.size <= 512 * 1024) : null
      if (readme) {
        try { fs.copyFileSync(readme.abs, path.join(originalsDir, safeName(readme.name))) } catch { /* 读不到就不存快照 */ }
      }
      originalCopy = path.posix.join(folderRel, 'originals', 'repo.json')
    } else if (kind === 'file') {
      const originalName = safeName(path.basename(sourceLabel))
      try { fs.copyFileSync(sourceLabel, path.join(originalsDir, originalName)); originalCopy = path.posix.join(folderRel, 'originals', originalName) } catch { /* 原件缺失不阻塞 */ }
    } else {
      const originalName = kind === 'session' ? 'session-transcript.md' : 'input.md'
      fs.writeFileSync(path.join(originalsDir, originalName), sourceText, 'utf8')
      originalCopy = path.posix.join(folderRel, 'originals', originalName)
    }

    const slug = slugOf(finalTitle, 'structured')
    let target = path.join(processedDir, slug + '.md')
    counter = 2
    while (fs.existsSync(target)) {
      target = path.join(processedDir, `${slug}-${counter}.md`)
      counter += 1
    }
    const relTarget = path.relative(root, target).replace(/\\/g, '/')
    const markdown = frontMatter({
      title: finalTitle,
      source: sourceLabel,
      kind,
      collection,
      importedAt,
      original: originalCopy,
      instructions,
      aiStructured: true,
      stats,
      sessionId,
      git,
    }) + cleanBody.trim() + '\n'
    fs.writeFileSync(target, markdown, 'utf8')
    try {
      fs.writeFileSync(path.join(folderAbs, '.meta.json'), JSON.stringify({
        version: 1,
        kind,
        collection,
        folder: folderName,
        prefix,
        source: sourceLabel,
        original: originalCopy,
        processed: relTarget,
        title: finalTitle,
        format: kind === 'repo' ? 'repository' : kind,
        importedAt,
        aiStructured: true,
        instructions,
        stats,
        git,
        sessionId,
        warnings,
      }, null, 2), 'utf8')
    } catch (error) {
      warnings.push(`元数据写入失败：${error instanceof Error ? error.message : String(error)}`)
    }
    let reindexJobId = null
    if (shouldReindex && reindex && typeof reindex.start === 'function') {
      try {
        const started = reindex.start({ names: [collection] })
        reindexJobId = started && started.job ? started.job.id : null
      } catch (error) {
        warnings.push(`索引重建启动失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return {
      ok: true,
      imported: true,
      kind,
      title: finalTitle,
      source: sourceLabel,
      target: relTarget,
      original: originalCopy,
      folder: folderName,
      collection,
      prefix,
      git,
      stats,
      warnings,
      reindexJobId,
      body: cleanBody,
      chars: cleanBody.length,
      sessionId,
    }
  }

  return { run }
}
