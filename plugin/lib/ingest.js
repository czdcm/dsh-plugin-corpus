/**
 * dsh-plugin-corpus — 导入任务（v1.3）。
 *
 * 把一组本机文件/浏览器上传的文档变成语料库里的 Markdown：
 *   提取（extract.js）→ 可选「内置摄取小代理」结构化/总结
 *   → 写 <root>/<collection>/<prefix?>/<slug>.md → 触发后台重建。
 *
 * 同一时刻只跑一个导入任务；任务状态给面板轮询。
 */
import fs from 'node:fs'
import path from 'node:path'
import { SUPPORTED_EXTENSIONS, extractDocument, runWindowsOcr } from './extract.js'
import { extractFormulaLines, normalizeLatex } from './formulas.js'
import { collectionNameError, isValidCollectionName } from './collection-name.js'

const SUPPORTED = new Set(SUPPORTED_EXTENSIONS)
const SKIP_DIRS = new Set(['node_modules', '.git', '.corpus', '.dsh-knowledge', '__pycache__', '.svn', '.hg'])
const MAX_FILES = 200
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const MAX_SOURCE_BYTES = 100 * 1024 * 1024
const HISTORY_LIMIT = 10

function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function safeName(value) {
  return String(value || 'file')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'file'
}

function slugOf(title, fallback) {
  const base = String(title || fallback || 'document')
    .replace(/^#+\s*/, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 80)
  return base || 'document'
}

function normalizePrefix(value) {
  const text = String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (text === '') return ''
  const parts = text.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) throw new Error('prefix 不能包含 . 或 ..')
  return parts.join('/')
}

function stripFrontMatter(text) {
  const value = String(text || '')
  const match = value.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return match ? value.slice(match[0].length).trim() : value.trim()
}

function yamlString(value) {
  return JSON.stringify(String(value === undefined || value === null ? '' : value))
}

function headingOutline(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => /^#{1,6}\s+\S/.test(line.trim()))
    .slice(0, 40)
}

function deterministicBody({ title, source, format, text, warnings, formulas }) {
  const lines = [`# ${title}`, '', `> 导入自 ${source}（${format}）。`, '']
  if (warnings.length > 0) {
    lines.push(`> 提取提示：${warnings.join('；')}`, '')
  }
  const outline = headingOutline(text)
  if (outline.length > 0) {
    lines.push('## 文档结构', '', ...outline.map((line) => `- ${line.replace(/^#+\s*/, '')}`), '')
  }
  if (Array.isArray(formulas) && formulas.length > 0) {
    lines.push('## 公式（LaTeX）', '', ...formulas.map((formula) => `- ${formula}`), '')
  }
  lines.push('## 正文', '', text.trim(), '')
  return lines.join('\n')
}

function composeMarkdown({ title, source, format, collection, importedAt, aiStructured, body, warnings }) {
  const front = [
    '---',
    `title: ${yamlString(title)}`,
    `source: ${yamlString(source)}`,
    `format: ${yamlString(format)}`,
    `importedAt: ${yamlString(importedAt)}`,
    `collection: ${yamlString(collection)}`,
    `aiStructured: ${aiStructured ? 'true' : 'false'}`,
  ]
  front.push('---', '')
  const note = warnings.length > 0 ? [`> 提取提示：${warnings.join('；')}`, ''] : []
  const cleanBody = stripFrontMatter(body)
  const bodyText = cleanBody.startsWith('# ') ? cleanBody : `# ${title}\n\n${cleanBody}`
  return front.join('\n') + '\n' + note.join('\n') + bodyText.trim() + '\n'
}

function publicJob(job) {
  if (!job) return null
  const snapshot = {}
  for (const [key, value] of Object.entries(job)) {
    if (key.startsWith('_')) continue
    if (key === 'current' && value) snapshot.current = { ...value }
    else if (key === 'items') snapshot.items = value.map((item) => ({ ...item }))
    else snapshot[key] = value
  }
  return snapshot
}

function listSourceFiles(inputs, errors) {
  const files = []
  const walk = (dir, depth) => {
    if (depth > 12 || files.length >= MAX_FILES) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (error) {
      errors.push(`无法读取目录 ${dir}：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (!SUPPORTED.has(path.extname(entry.name).toLowerCase())) continue
      files.push(full)
    }
  }
  for (const input of inputs) {
    let stat
    try { stat = fs.lstatSync(input) } catch {
      errors.push(`找不到：${input}`)
      continue
    }
    if (stat.isSymbolicLink()) {
      errors.push(`跳过符号链接：${input}`)
      continue
    }
    if (stat.isFile()) {
      if (!SUPPORTED.has(path.extname(input).toLowerCase())) {
        errors.push(`不支持的格式：${path.basename(input)}`)
        continue
      }
      files.push(input)
    } else if (stat.isDirectory()) {
      walk(input, 0)
    }
  }
  return files
}

function decodeUploads(uploads, tempDir, errors) {
  const files = []
  fs.mkdirSync(tempDir, { recursive: true })
  for (const upload of Array.isArray(uploads) ? uploads : []) {
    const name = safeName(upload && upload.name)
    const ext = path.extname(name).toLowerCase()
    if (!SUPPORTED.has(ext)) {
      errors.push(`不支持的格式：${name}`)
      continue
    }
    const data = typeof upload.dataBase64 === 'string' ? upload.dataBase64 : ''
    const buffer = Buffer.from(data, 'base64')
    if (buffer.length === 0) {
      errors.push(`上传内容为空：${name}`)
      continue
    }
    if (buffer.length > MAX_UPLOAD_BYTES) {
      errors.push(`上传文件超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB：${name}`)
      continue
    }
    const file = path.join(tempDir, name)
    fs.writeFileSync(file, buffer)
    files.push(file)
    if (files.length >= MAX_FILES) break
  }
  return files
}

/**
 * @param root - 语料根。
 * @param dshHome - DSH_HOME（目前只用于日志/预留）。
 * @param reindex - createJobRunner 的返回值（start/status）。
 * @param agent - createIngestAgent 的返回值。
 * @param config - 插件配置。
 * @param log - 可选日志。
 */
export function createIngestManager({ root, dshHome, reindex, agent, config, log }) {
  const recent = []
  let active = null
  let disposed = false
  const tempRoot = path.join(root, '.corpus', 'import-tmp')

  const finish = (job, state, extra) => {
    if (job.state !== 'running') return
    job.state = state
    job.finishedAt = Date.now()
    job.ms = job.finishedAt - job.startedAt
    if (extra && typeof extra === 'object') Object.assign(job, extra)
    if (active === job) active = null
    recent.unshift(publicJob(job))
    if (recent.length > HISTORY_LIMIT) recent.length = HISTORY_LIMIT
  }

  const runJob = async (job, inputs) => {
    const items = []
    const errors = []
    let tempDir = null
    try {
      tempDir = path.join(tempRoot, job.id)
      const uploaded = decodeUploads(inputs.uploads, tempDir, errors)
      const paths = inputs.paths.slice()
      const files = listSourceFiles(paths, errors)
      const all = [...files, ...uploaded]
      job.total = all.length
      if (all.length === 0) {
        finish(job, 'error', { error: '没有找到可导入的文档（支持：' + SUPPORTED_EXTENSIONS.join(' ') + '）', items })
        return
      }
      for (let index = 0; index < all.length; index++) {
        const file = all[index]
        const display = path.basename(file)
        job.current = { source: display, stage: 'extract', index: index + 1, total: all.length }
        let extracted
        try {
          extracted = await extractDocument(file, { maxBytes: MAX_SOURCE_BYTES })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          items.push({ source: display, ok: false, error: message })
          job.failed += 1
          job.current = { source: display, stage: 'error', index: index + 1, total: all.length }
          continue
        }
        const warnings = extracted.warnings.slice()
        if (extracted.kind !== 'image' && String(extracted.text || '').trim() === '') {
          items.push({ source: display, ok: false, error: '没有提取到文本' + (warnings.length > 0 ? `（${warnings.join('；')}）` : '') })
          job.failed += 1
          job.current = { source: display, stage: 'error', index: index + 1, total: all.length }
          continue
        }
        const format = extracted.format
        let title = extracted.title || path.basename(file, path.extname(file))
        const source = path.basename(file)
        const importedAt = new Date().toISOString()
        let text = extracted.text
        const formulas = Array.isArray(extracted.meta && extracted.meta.formulas)
          ? extracted.meta.formulas.filter((formula) => typeof formula === 'string' && formula !== '')
          : extractFormulaLines(text)

        // 每次导入一个独立文件夹：只写 processed/ 结构化数据；源文件由用户自行管理。
        const collectionDir = path.resolve(root, job.collection)
        const parentDir = job.prefix ? path.join(collectionDir, job.prefix) : collectionDir
        const folderBase = `${stamp()}-${slugOf(path.basename(file, path.extname(file)), 'import')}`
        let folderName = folderBase
        let folderCounter = 2
        while (fs.existsSync(path.join(parentDir, folderName))) {
          folderName = `${folderBase}-${folderCounter}`
          folderCounter += 1
        }
        const folderRel = path.posix.join(job.collection, job.prefix ? `${job.prefix}/${folderName}` : folderName)
        const folderAbs = path.join(root, ...folderRel.split('/'))
        const processedDir = path.join(folderAbs, 'processed')
        fs.mkdirSync(processedDir, { recursive: true })

        let body = ''
        let aiStructured = false
        if (job.ai && agent && typeof agent.available === 'function' && agent.available()) {
          job.current = { source: display, stage: 'agent', index: index + 1, total: all.length }
          try {
            if (extracted.kind === 'image') {
              const canSeeImages = typeof agent.supportsImages === 'function' ? await agent.supportsImages() : false
              if (canSeeImages) {
                const imageData = await fs.promises.readFile(file)
                body = await agent.structureImages({
                  images: [{ data: new Uint8Array(imageData), mediaType: extracted.mediaType || 'image/png', name: source }],
                  meta: { title, source, format, collection: job.collection, warnings },
                })
              }
            } else {
              body = await agent.structure({
                text,
                meta: { title, source, format, collection: job.collection, warnings },
              })
            }
            if (body.trim() !== '') aiStructured = true
          } catch (error) {
            warnings.push(`小代理结构化失败，已回退：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        // 图片：视觉不可用/失败时，用插件内置的 Windows OCR 取文字。
        if (extracted.kind === 'image' && body.trim() === '') {
          job.current = { source: display, stage: 'extract', index: index + 1, total: all.length }
          try {
            const ocrText = await runWindowsOcr(file, 'image')
            if (String(ocrText || '').trim() !== '') {
              text = ocrText
              warnings.push('图片已用插件内置的 Windows OCR 提取文字')
            }
          } catch (error) {
            warnings.push(`图片 OCR 失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (body.trim() === '') {
          if (extracted.kind === 'image' && String(text || '').trim() === '') {
            items.push({ source: display, ok: false, error: '图片没有可用的文字：视觉模型与 OCR 都不可用' })
            job.failed += 1
            continue
          }
          body = deterministicBody({ title, source, format, text, warnings, formulas })
        }
        body = normalizeLatex(body)
        if (formulas.length > 0 && !/\$\$[\s\S]*\$\$|\$[^$\n]+\$/.test(body)) {
          body += `\n\n## 公式（LaTeX）\n\n${formulas.map((formula) => `- ${formula}`).join('\n')}\n`
        }
        const aiTitle = String(body).match(/^#\s+(.+)$/m)
        if (aiTitle) title = aiTitle[1].trim().slice(0, 160) || title

        job.current = { source: display, stage: 'write', index: index + 1, total: all.length }
        const slug = slugOf(title, path.basename(file, path.extname(file)))
        let target = path.join(processedDir, slug + '.md')
        let counter = 2
        while (fs.existsSync(target)) {
          target = path.join(processedDir, `${slug}-${counter}.md`)
          counter += 1
        }
        const relTarget = path.relative(root, target).replace(/\\/g, '/')
        const collectionBase = path.resolve(root, job.collection)
        if (!(target === collectionBase || target.startsWith(collectionBase + path.sep))) {
          items.push({ source: display, ok: false, error: '目标路径越界' })
          job.failed += 1
          continue
        }
        try {
          const markdown = composeMarkdown({
            title,
            source,
            format,
            collection: job.collection,
            importedAt,
            aiStructured,
            body,
            warnings,
          })
          fs.writeFileSync(target, markdown, 'utf8')
          try {
            const meta = {
              version: 1,
              collection: job.collection,
              folder: folderName,
              prefix: job.prefix || '',
              source,
              processed: relTarget,
              title,
              format,
              mediaType: extracted.mediaType || null,
              importedAt,
              aiStructured,
              formulaCount: formulas.length,
              bytes: extracted.meta && typeof extracted.meta.bytes === 'number' ? extracted.meta.bytes : null,
              warnings,
            }
            fs.writeFileSync(path.join(folderAbs, '.meta.json'), JSON.stringify(meta, null, 2), 'utf8')
          } catch (metaError) {
            warnings.push(`元数据写入失败：${metaError instanceof Error ? metaError.message : String(metaError)}`)
          }
          items.push({
            source: display,
            ok: true,
            target: relTarget,
            folder: folderName,
            format,
            chars: extracted.kind === 'image' ? body.length : text.length,
            aiStructured,
            warnings,
          })
          job.done += 1
        } catch (error) {
          items.push({ source: display, ok: false, error: error instanceof Error ? error.message : String(error) })
          job.failed += 1
        }
      }

      let reindexJobId = null
      if (job.done > 0 && job.index && reindex && typeof reindex.start === 'function') {
        job.current = { source: '', stage: 'index', index: all.length, total: all.length }
        try {
          const started = reindex.start({ names: [job.collection] })
          reindexJobId = started.job ? started.job.id : null
        } catch (error) {
          errors.push(`索引重建启动失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      finish(job, 'done', {
        items,
        result: { collection: job.collection, total: all.length, imported: job.done, failed: job.failed, reindexJobId, errors },
        reindexJobId,
        current: null,
      })
      if (log) log('info', `导入完成：${job.done}/${all.length} -> ${job.collection}`)
    } catch (error) {
      finish(job, 'error', { error: error instanceof Error ? error.message : String(error), items })
    } finally {
      if (tempDir) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch { /* 清理失败不影响结果 */ }
      }
    }
  }

  const start = (options = {}) => {
    if (disposed) throw new Error('导入任务管理器已关闭')
    if (active) return { started: false, job: publicJob(active) }
    const collection = String(options.collection || '').trim()
    if (!isValidCollectionName(collection)) {
      throw new Error(collectionNameError(collection))
    }
    const prefix = normalizePrefix(options.prefix)
    const paths = (Array.isArray(options.paths) ? options.paths : (options.path ? [options.path] : []))
      .filter((item) => typeof item === 'string' && item.trim() !== '')
      .map((item) => path.resolve(item))
    const uploads = Array.isArray(options.uploads) ? options.uploads : []
    if (paths.length === 0 && uploads.length === 0) throw new Error('至少提供一个 path 或 files')
    const job = {
      id: `ingest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      state: 'running',
      collection,
      prefix,
      ai: options.ai !== false,
      index: options.index !== false,
      startedAt: Date.now(),
      finishedAt: null,
      ms: null,
      total: 0,
      done: 0,
      failed: 0,
      current: null,
      items: [],
      result: null,
      error: null,
      reindexJobId: null,
    }
    active = job
    setImmediate(() => { void runJob(job, { paths, uploads }) })
    return { started: true, job: publicJob(job) }
  }

  const status = () => ({
    active: publicJob(active),
    recent: recent.map((job) => ({ ...job, items: job.items.map((item) => ({ ...item })) })),
  })

  const dispose = () => {
    disposed = true
    if (active) {
      finish(active, 'error', { error: '任务随插件关闭被终止' })
    }
  }

  return {
    start,
    status,
    dispose,
    aiAvailable: () => Boolean(agent && typeof agent.available === 'function' && agent.available()),
    visionAvailable: async () => {
      try {
        return Boolean(agent && typeof agent.supportsImages === 'function' && await agent.supportsImages())
      } catch {
        return false
      }
    },
    visionStatus: async () => {
      try {
        if (agent && typeof agent.visionStatus === 'function') return await agent.visionStatus()
        return { available: false, reason: '摄取小代理不可用' }
      } catch (error) {
        return { available: false, reason: error instanceof Error ? error.message : String(error) }
      }
    },
    limits: { maxFiles: MAX_FILES, maxUploadBytes: MAX_UPLOAD_BYTES },
  }
}
