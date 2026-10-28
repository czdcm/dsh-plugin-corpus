/**
 * dsh-plugin-corpus — 引擎（全局语料根版，v1.1）。
 *
 * 布局：
 *   <CORPUS_ROOT>/<collection>/...            内容（文件是本体）
 *   <CORPUS_ROOT>/.corpus/index/<collection>.sqlite   每个集合一份可重建索引
 *   <CORPUS_ROOT>/.corpus/config.json         每集合的后端与文件过滤
 *
 * 检索后端：
 *   like     —— 分块表 + LIKE（中文/英文子串都能命中），默认
 *   ripgrep  —— 不建索引，直接 rg 扫文件（给上 GB 的代码仓用）
 *
 * v1.1 新增：导入（importInto）、集合状态（collectionStatus）、统计（stats）、
 * 重建进度回调（onProgress）；读取路径做了 realpath/符号链接/扩展名加固。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { collectionNameError, isValidCollectionName } from './collection-name.js'

export const META_DIR = '.corpus'
export const TEXT_EXT = new Set(['.md', '.markdown', '.mdx', '.txt', '.rst', '.text', '.json', '.yaml', '.yml'])
export const SKIP_DIRS = new Set(['node_modules', '.git', '.corpus', '.dsh-knowledge', '__pycache__', '.svn', '.hg', 'originals'])
const DEFAULT_MAX_FILE = 4 * 1024 * 1024
const CHUNK_CHARS = 1200
const MAX_IMPORT_FILES = 5000

function sha(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export function metaDir(root) { return path.join(root, META_DIR) }
export function indexPath(root, name) { return path.join(metaDir(root), 'index', name + '.sqlite') }
export function configPath(root) { return path.join(metaDir(root), 'config.json') }

/** 根下的一级目录 = 集合。 */
export function collectionNames(root) {
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .filter((entry) => isValidCollectionName(entry.name))
    .map((entry) => entry.name)
    .sort()
}

export function readConfig(root) {
  const file = configPath(root)
  if (!fs.existsSync(file)) return { version: 1, collections: {} }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { version: 1, collections: {}, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
  } catch {
    return { version: 1, collections: {} }
  }
}

/** 一个集合实际生效的后端、扩展名与单文件上限。 */
export function collectionSettings(root, name) {
  const config = readConfig(root)
  const specific = config.collections && config.collections[name] ? config.collections[name] : {}
  const defaults = config.defaults && typeof config.defaults === 'object' ? config.defaults : {}
  const backend = specific.backend || defaults.backend || 'like'
  const ext = Array.isArray(specific.extensions) ? specific.extensions
    : Array.isArray(defaults.extensions) ? defaults.extensions : null
  const extensions = ext ? new Set(ext.map((item) => String(item).toLowerCase())) : TEXT_EXT
  const maxFileBytes = Number(specific.maxFileBytes || defaults.maxFileBytes) || DEFAULT_MAX_FILE
  return { backend, extensions, maxFileBytes }
}

/** 找出可用的 ripgrep：环境变量 > PATH > DSH 自带。 */
export function findRipgrep() {
  if (process.env.CORPUS_RG && fs.existsSync(process.env.CORPUS_RG)) return process.env.CORPUS_RG
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg'
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, exe)
    if (fs.existsSync(candidate)) return candidate
  }
  try {
    const resources = typeof process.resourcesPath === 'string' ? process.resourcesPath : ''
    const roots = [resources, path.dirname(process.execPath)]
    for (const base of roots) {
      if (!base) continue
      const packages = path.join(base, 'app.asar.unpacked', 'dsh', 'node_modules', '@vscode')
      if (!fs.existsSync(packages)) continue
      for (const entry of fs.readdirSync(packages)) {
        const candidate = path.join(packages, entry, 'bin', exe)
        if (fs.existsSync(candidate)) return candidate
      }
    }
  } catch { /* 找不到就当没有 */ }
  return null
}

function openDb(root, name) {
  const file = indexPath(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const database = new DatabaseSync(file)
  // 面板/工具可能与 worker 重建并发读；WAL + busy_timeout 让短时争用自动重试。
  try { database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;') } catch { /* 老版本 sqlite 不支持 WAL 时退回默认 */ }
  database.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      bytes INTEGER NOT NULL, mtime INTEGER NOT NULL, hash TEXT NOT NULL, chunks INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL, ord INTEGER NOT NULL,
      heading TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)
  return database
}

function openReadDb(root, name) {
  const file = indexPath(root, name)
  if (!fs.existsSync(file)) return null
  const database = new DatabaseSync(file, { readOnly: true })
  try { database.exec('PRAGMA busy_timeout = 5000') } catch { /* 只读连接也可用默认值 */ }
  return database
}

/** 收集一个集合里的候选文件（集合内相对路径）。符号链接、隐藏项、超限文件跳过。 */
export function scanCollection(root, name) {
  const { extensions, maxFileBytes } = collectionSettings(root, name)
  const base = path.join(root, name)
  const found = []
  const walk = (dir, depth) => {
    if (depth > 12) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(full, depth + 1)
      } else if (entry.isFile()) {
        if (!extensions.has(path.extname(entry.name).toLowerCase())) continue
        let stat
        try { stat = fs.statSync(full) } catch { continue }
        if (stat.size > maxFileBytes) continue
        found.push(path.relative(base, full).replace(/\\/g, '/'))
      }
    }
  }
  walk(base, 0)
  return found.sort()
}

function titleOf(relPath, text) {
  const first = text.match(/^#\s+(.+)$/m)
  if (first) return first[1].trim().slice(0, 120)
  const fm = text.match(/^---\n[\s\S]*?title:\s*"([^"]+)"/)
  if (fm) return fm[1].slice(0, 120)
  return path.basename(relPath).replace(/\.[^.]+$/, '')
}

export function chunkText(text) {
  const lines = text.split(/\r?\n/)
  const chunks = []
  let heading = ''
  let buffer = []
  let start = 1
  const flush = (endLine) => {
    const body = buffer.join('\n').trim()
    buffer = []
    if (body === '') return
    if (body.length <= CHUNK_CHARS) {
      chunks.push({ heading, text: body, startLine: start, endLine })
      return
    }
    let cursor = 0
    let lineCursor = start
    while (cursor < body.length) {
      let take = Math.min(CHUNK_CHARS, body.length - cursor)
      const slice = body.slice(cursor, cursor + take)
      const cut = slice.lastIndexOf('\n\n')
      if (cut > take / 2) take = cut
      const piece = body.slice(cursor, cursor + take).trim()
      const pieceLines = body.slice(cursor, cursor + take).split('\n').length
      if (piece !== '') {
        chunks.push({ heading, text: piece, startLine: lineCursor, endLine: Math.min(endLine, lineCursor + pieceLines - 1) })
      }
      lineCursor += pieceLines
      cursor += take
    }
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const match = /^(#{1,6})\s+(.*)$/.exec(line)
    if (match) {
      flush(index)
      heading = match[2].trim()
      buffer = [line]
      start = index + 1
    } else {
      if (buffer.length === 0) start = index + 1
      buffer.push(line)
    }
  }
  flush(lines.length)
  return chunks
}

/**
 * 重建若干集合的索引（默认全部；like 后端才有索引）。
 * @param options.names - 集合名。
 * @param options.force - 忽略文件时间全部重切。
 * @param options.onProgress - 每进入一个集合回调一次 {collection,index,total,phase}。
 */
export function reindex(root, options = {}) {
  const started = Date.now()
  const names = Array.isArray(options.names) && options.names.length > 0 ? options.names : collectionNames(root)
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null
  const report = []
  for (let index = 0; index < names.length; index++) {
    const name = names[index]
    if (!fs.existsSync(path.join(root, name))) continue
    const settings = collectionSettings(root, name)
    if (onProgress) {
      try { onProgress({ collection: name, index: index + 1, total: names.length, phase: 'start' }) } catch { /* 进度回调失败不影响重建 */ }
    }
    if (settings.backend === 'ripgrep') {
      report.push({ collection: name, backend: 'ripgrep', docs: 0, chunks: 0, note: '该集合按需用 rg 扫描，不建索引' })
      if (onProgress) {
        try { onProgress({ collection: name, index: index + 1, total: names.length, phase: 'done' }) } catch { /* 同上 */ }
      }
      continue
    }
    const base = path.join(root, name)
    const files = scanCollection(root, name)
    const database = openDb(root, name)
    try {
      const known = new Map()
      for (const row of database.prepare('SELECT id, path, mtime, bytes FROM docs').all()) known.set(row.path, row)
      let added = 0, updated = 0, skipped = 0, removed = 0
      const seen = new Set()
      const binary = new Set()
      for (const rel of files) {
        seen.add(rel)
        const abs = path.join(base, rel)
        let stat
        try { stat = fs.statSync(abs) } catch { continue }
        const previous = known.get(rel)
        if (!options.force && previous && previous.mtime === Math.floor(stat.mtimeMs) && previous.bytes === stat.size) {
          skipped++
          continue
        }
        let text
        try { text = fs.readFileSync(abs, 'utf8') } catch { continue }
        if (text.includes('\u0000')) { binary.add(rel); continue }
        const pieces = chunkText(text)
        const title = titleOf(rel, text)
        database.exec('BEGIN')
        try {
          let docId
          if (previous) {
            docId = previous.id
            database.prepare('UPDATE docs SET title=?, bytes=?, mtime=?, hash=?, chunks=? WHERE id=?')
              .run(title, stat.size, Math.floor(stat.mtimeMs), sha(text), pieces.length, docId)
            database.prepare('DELETE FROM chunks WHERE doc_id=?').run(docId)
            updated++
          } else {
            const info = database.prepare('INSERT INTO docs (path,title,bytes,mtime,hash,chunks) VALUES (?,?,?,?,?,?)')
              .run(rel, title, stat.size, Math.floor(stat.mtimeMs), sha(text), pieces.length)
            docId = Number(info.lastInsertRowid)
            added++
          }
          const insert = database.prepare('INSERT INTO chunks (doc_id,ord,heading,text,start_line,end_line) VALUES (?,?,?,?,?,?)')
          pieces.forEach((piece, ord) => insert.run(docId, ord, piece.heading, piece.text, piece.startLine, piece.endLine))
          database.exec('COMMIT')
        } catch (error) {
          database.exec('ROLLBACK')
          throw error
        }
      }
      for (const [rel, row] of known) {
        if (seen.has(rel) && !binary.has(rel)) continue
        database.exec('BEGIN')
        try {
          database.prepare('DELETE FROM chunks WHERE doc_id=?').run(row.id)
          database.prepare('DELETE FROM docs WHERE id=?').run(row.id)
          database.exec('COMMIT')
          removed++
        } catch { database.exec('ROLLBACK') }
      }
      const totals = database.prepare('SELECT COUNT(*) AS docs, (SELECT COUNT(*) FROM chunks) AS chunks FROM docs').get()
      database.prepare("INSERT INTO meta (key,value) VALUES ('indexed_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(new Date().toISOString())
      report.push({ collection: name, backend: 'like', docs: Number(totals.docs), chunks: Number(totals.chunks), added, updated, removed, skipped })
    } finally {
      try { database.close() } catch { /* 已关闭 */ }
    }
    if (onProgress) {
      const last = report[report.length - 1]
      try { onProgress({ collection: name, index: index + 1, total: names.length, phase: 'done', docs: last && last.docs, chunks: last && last.chunks }) } catch { /* 同上 */ }
    }
  }
  return { ok: true, root, ms: Date.now() - started, collections: report }
}

function likeSearch(root, name, terms, limit) {
  const database = openDb(root, name)
  try {
    const where = terms.map(() => '(c.text LIKE ? OR c.heading LIKE ?)').join(' AND ')
    const params = []
    for (const term of terms) { const like = '%' + term + '%'; params.push(like, like) }
    const rows = database.prepare(`
      SELECT d.path, d.title, c.heading, c.text, c.start_line, c.end_line
      FROM chunks c JOIN docs d ON d.id = c.doc_id
      WHERE ${where} ORDER BY d.path, c.ord LIMIT ?
    `).all(...params, limit)
    return rows.map((row) => {
      const lower = String(row.text).toLowerCase()
      let score = 0
      for (const term of terms) {
        let at = lower.indexOf(term.toLowerCase())
        while (at !== -1) { score++; at = lower.indexOf(term.toLowerCase(), at + term.length) }
      }
      return {
        collection: name, path: name + '/' + row.path, title: row.title, heading: row.heading,
        lines: `${row.start_line}-${row.end_line}`, score, snippet: snippetOf(String(row.text), terms),
      }
    })
  } finally {
    try { database.close() } catch { /* 已关闭 */ }
  }
}

function ripgrepSearch(root, name, terms, limit) {
  const rg = findRipgrep()
  if (!rg) return null
  const base = path.join(root, name)
  const files = (() => {
    let acc = null
    for (const term of terms) {
      let out = ''
      try {
        out = execFileSync(rg, ['-l', '--no-messages', '-F', '--', term, '.'], { cwd: base, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      } catch (error) {
        if (error && error.status === 1) out = ''
        else throw error
      }
      const set = new Set(out.split(/\r?\n/).filter(Boolean).map((item) => item.replace(/^\.\//, '')))
      acc = acc === null ? set : new Set([...acc].filter((item) => set.has(item)))
      if (acc.size === 0) break
    }
    return [...(acc || new Set())].slice(0, limit)
  })()
  const hits = []
  for (const rel of files) {
    let out = ''
    try {
      out = execFileSync(rg, ['-n', '--no-messages', '-F', '-m', '1', '--', terms[0], rel], { cwd: base, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    } catch (error) {
      if (!(error && error.status === 1)) throw error
    }
    const match = out.split(/\r?\n/).find(Boolean)
    const lineNo = match ? Number(match.split(':')[0]) : 1
    hits.push({
      collection: name, path: name + '/' + rel, title: path.basename(rel).replace(/\.[^.]+$/, ''),
      heading: '', lines: String(lineNo), score: 1,
      snippet: match ? match.replace(/^[^:]+:\d+:/, '').slice(0, 220) : '',
    })
  }
  return hits
}

function snippetOf(text, terms) {
  const flat = text.replace(/\s+/g, ' ').trim()
  const lower = flat.toLowerCase()
  let at = -1
  for (const term of terms) {
    const index = lower.indexOf(term.toLowerCase())
    if (index !== -1 && (at === -1 || index < at)) at = index
  }
  if (at === -1) at = 0
  const from = Math.max(0, at - 60)
  return (from > 0 ? '…' : '') + flat.slice(from, from + 220) + (from + 220 < flat.length ? '…' : '')
}

/**
 * 在指定集合里检索。
 * @param root - 语料根。
 * @param options.collections - 已按权限过滤的集合名。
 * @param options.query - 关键词（空格分隔，全部命中）。
 */
export function search(root, options) {
  const query = String(options.query || '').trim()
  if (query === '') throw new Error('query 不能为空')
  const terms = query.split(/\s+/).filter(Boolean).slice(0, 4)
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 8))
  const names = Array.isArray(options.collections) ? options.collections : collectionNames(root)
  const all = []
  const used = []
  for (const name of names) {
    const settings = collectionSettings(root, name)
    let hits = null
    if (settings.backend === 'ripgrep') hits = ripgrepSearch(root, name, terms, limit)
    if (hits === null) hits = likeSearch(root, name, terms, limit)
    if (hits.length > 0) used.push(`${name}:${settings.backend === 'ripgrep' && findRipgrep() ? 'rg' : 'like'}`)
    all.push(...hits)
  }
  all.sort((left, right) => right.score - left.score)
  return { ok: true, query, terms, collections: used, hits: all.slice(0, limit) }
}

/** 按行读一个文件（relPath 形如 `collection/sub/file.md`）。v1.1 加固。 */
export function readFile(root, relPath, options = {}) {
  const rel = String(relPath || '').replace(/\\/g, '/')
  if (rel === '' || rel.split('/').some((segment) => segment === '' || segment === '..' || segment === 'originals')) {
    throw new Error('path 必须是语料根内 processed 的相对路径')
  }
  const first = rel.split('/')[0]
  if (!collectionNames(root).includes(first)) throw new Error(`不在已知集合内：${first}`)
  const settings = collectionSettings(root, first)
  if (!settings.extensions.has(path.extname(rel).toLowerCase())) throw new Error(`不是可读取的语料文件：${rel}`)
  const rootAbs = path.resolve(root)
  const abs = path.resolve(rootAbs, rel)
  let stat
  try { stat = fs.lstatSync(abs) } catch { throw new Error(`找不到文件：${rel}`) }
  if (stat.isSymbolicLink()) throw new Error('不允许读取符号链接')
  if (!stat.isFile()) throw new Error(`不是文件：${rel}`)
  let real
  try { real = fs.realpathSync(abs) } catch { throw new Error(`找不到文件：${rel}`) }
  let realRoot
  try { realRoot = fs.realpathSync(rootAbs) } catch { realRoot = rootAbs }
  const outside = path.relative(realRoot, real)
  if (outside.startsWith('..') || path.isAbsolute(outside)) throw new Error('路径越界')
  const text = fs.readFileSync(abs, 'utf8')
  if (text.includes('\u0000')) throw new Error(`不是文本文件：${rel}`)
  const lines = text.split(/\r?\n/)
  const from = Math.max(1, Number(options.from) || 1)
  const count = Math.max(1, Math.min(400, Number(options.lines) || 120))
  const slice = lines.slice(from - 1, from - 1 + count)
  return {
    ok: true, path: rel, totalLines: lines.length, from,
    to: Math.min(lines.length, from + slice.length - 1),
    truncated: from - 1 + slice.length < lines.length,
    text: slice.map((line, index) => `${String(from + index).padStart(6)}| ${line}`).join('\n'),
  }
}

/** 列出集合与文件（只列有权限的集合）。 */
export function listDocs(root, options = {}) {
  const names = Array.isArray(options.collections) ? options.collections : collectionNames(root)
  const limit = Math.max(1, Math.min(1000, Number(options.limit) || 200))
  const collections = []
  let total = 0
  for (const name of names) {
    const settings = collectionSettings(root, name)
    if (settings.backend === 'ripgrep') {
      const count = scanCollection(root, name).length
      total += count
      collections.push({ name, backend: 'ripgrep', docs: count, chunks: 0, indexedAt: null, files: [] })
      continue
    }
    let rows = []
    let indexedAt = null
    if (fs.existsSync(indexPath(root, name))) {
      const database = openReadDb(root, name)
      if (database) {
        try {
          rows = database.prepare('SELECT path, title, chunks, bytes FROM docs ORDER BY path LIMIT ?').all(limit)
          const meta = database.prepare("SELECT value FROM meta WHERE key='indexed_at'").get()
          indexedAt = meta ? meta.value : null
        } finally {
          try { database.close() } catch { /* 已关闭 */ }
        }
      }
    }
    total += rows.length
    collections.push({
      name, backend: 'like', docs: rows.length,
      chunks: rows.reduce((sum, row) => sum + Number(row.chunks), 0),
      indexedAt,
      files: rows.map((row) => ({ path: name + '/' + row.path, title: row.title, chunks: Number(row.chunks), bytes: Number(row.bytes) })),
    })
  }
  return { ok: true, root, total, collections }
}

function indexBytesOf(root, name) {
  const dir = path.dirname(indexPath(root, name))
  if (!fs.existsSync(dir)) return 0
  try {
    return fs.readdirSync(dir)
      .filter((entry) => entry.startsWith(name + '.sqlite'))
      .reduce((sum, entry) => {
        try { return sum + fs.statSync(path.join(dir, entry)).size } catch { return sum }
      }, 0)
  } catch {
    return 0
  }
}

/** 每个集合的索引概况（给 corpus_status 与面板）。 */
export function collectionStatus(root) {
  const out = []
  for (const name of collectionNames(root)) {
    const settings = collectionSettings(root, name)
    if (settings.backend === 'ripgrep') {
      const files = scanCollection(root, name)
      let bytes = 0
      for (const rel of files) {
        try { bytes += fs.statSync(path.join(root, name, rel)).size } catch { /* 文件刚好消失 */ }
      }
      out.push({ name, backend: 'ripgrep', docs: files.length, chunks: 0, bytes, indexedAt: null, indexBytes: 0 })
      continue
    }
    const file = indexPath(root, name)
    if (!fs.existsSync(file)) {
      out.push({ name, backend: 'like', docs: 0, chunks: 0, bytes: 0, indexedAt: null, indexBytes: 0 })
      continue
    }
    const database = openReadDb(root, name)
    if (!database) {
      out.push({ name, backend: 'like', docs: 0, chunks: 0, bytes: 0, indexedAt: null, indexBytes: indexBytesOf(root, name) })
      continue
    }
    try {
      const row = database.prepare('SELECT COUNT(*) AS docs, COALESCE(SUM(bytes),0) AS bytes, COALESCE(SUM(chunks),0) AS chunks FROM docs').get()
      const meta = database.prepare("SELECT value FROM meta WHERE key='indexed_at'").get()
      out.push({
        name, backend: 'like',
        docs: Number(row.docs), chunks: Number(row.chunks), bytes: Number(row.bytes),
        indexedAt: meta ? meta.value : null,
        indexBytes: indexBytesOf(root, name),
      })
    } finally {
      try { database.close() } catch { /* 已关闭 */ }
    }
  }
  return out
}

/** 语料根总览。 */
export function stats(root) {
  const collections = collectionStatus(root)
  return {
    collections: collections.length,
    docs: collections.reduce((sum, item) => sum + item.docs, 0),
    chunks: collections.reduce((sum, item) => sum + item.chunks, 0),
    bytes: collections.reduce((sum, item) => sum + item.bytes, 0),
    indexBytes: collections.reduce((sum, item) => sum + item.indexBytes, 0),
  }
}

function isBinaryFile(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buffer = Buffer.alloc(8192)
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, read).includes(0)
  } catch {
    return true
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* 已关闭 */ }
    }
  }
}

function normalizePrefix(value) {
  const text = String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (text === '') return ''
  const parts = text.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) throw new Error('prefix 不能包含 . 或 ..')
  return parts.join('/')
}

/**
 * 把一个文件或目录导入 <root>/<collection>/。
 * 只复制普通文本文件；符号链接、隐藏项、超限与二进制文件跳过。
 */
export function importInto(root, options = {}) {
  const collection = String(options.collection || '').trim()
  if (!isValidCollectionName(collection)) {
    throw new Error(collectionNameError(collection))
  }
  const source = path.resolve(String(options.source || ''))
  let sourceStat
  try { sourceStat = fs.lstatSync(source) } catch { throw new Error(`找不到源路径：${source}`) }
  if (sourceStat.isSymbolicLink()) throw new Error('不允许导入符号链接')
  if (!sourceStat.isFile() && !sourceStat.isDirectory()) throw new Error('源路径既不是文件也不是目录')

  const settings = collectionSettings(root, collection)
  const extensions = Array.isArray(options.extensions) && options.extensions.length > 0
    ? new Set(options.extensions.map((item) => {
        const ext = String(item || '').trim().toLowerCase()
        if (ext === '') return ''
        return ext.startsWith('.') ? ext : '.' + ext
      }).filter(Boolean))
    : settings.extensions
  const prefix = normalizePrefix(options.prefix)
  const move = options.move === true
  const maxFiles = Math.max(1, Math.min(20000, Number(options.maxFiles) || MAX_IMPORT_FILES))
  const base = path.resolve(root, collection)
  const notes = []
  const files = []
  let imported = 0
  let skipped = 0
  let bytes = 0
  let truncated = false

  const add = (file) => {
    if (files.length >= maxFiles) {
      if (!truncated) { truncated = true; notes.push(`达到单次上限 ${maxFiles} 个文件，其余跳过`) }
      skipped++
      return
    }
    let stat
    try { stat = fs.lstatSync(file) } catch { skipped++; return }
    if (!stat.isFile() || stat.isSymbolicLink()) { skipped++; return }
    if (!extensions.has(path.extname(file).toLowerCase())) { skipped++; return }
    if (stat.size > settings.maxFileBytes) {
      skipped++
      if (notes.length < 50) notes.push(`跳过超限文件（${stat.size} 字节）：${path.basename(file)}`)
      return
    }
    if (isBinaryFile(file)) {
      skipped++
      if (notes.length < 50) notes.push(`跳过二进制文件：${path.basename(file)}`)
      return
    }
    const fromDir = sourceStat.isDirectory() ? source : path.dirname(source)
    const rel = path.relative(fromDir, file).replace(/\\/g, '/')
    if (rel === '' || rel.split('/').some((part) => part === '..')) { skipped++; return }
    const targetRel = prefix ? `${prefix}/${rel}` : rel
    const dest = path.resolve(base, targetRel)
    if (dest !== base && !dest.startsWith(base + path.sep)) { skipped++; return }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      if (fs.existsSync(dest) && notes.length < 50) notes.push(`覆盖：${targetRel}`)
      fs.copyFileSync(file, dest)
      if (move) { try { fs.rmSync(file, { force: true }) } catch { /* 复制成功就算导入 */ } }
      imported++
      bytes += stat.size
      files.push(path.posix.join(collection, targetRel))
    } catch (error) {
      skipped++
      if (notes.length < 50) notes.push(`复制失败：${targetRel}（${error instanceof Error ? error.message : String(error)}）`)
    }
  }

  if (sourceStat.isDirectory()) {
    const walk = (dir, depth) => {
      if (depth > 12) return
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue
          walk(full, depth + 1)
        } else if (entry.isFile()) {
          add(full)
        }
      }
    }
    walk(source, 0)
  } else {
    add(source)
  }

  return {
    ok: true,
    collection,
    source,
    imported,
    skipped,
    bytes,
    fileCount: files.length,
    files: files.slice(0, 100),
    filesTruncated: files.length > 100,
    notes: notes.slice(0, 50),
    truncated,
  }
}
