/**
 * dsh-plugin-corpus — 面板 HTTP API（v1.2）。
 *
 * 只服务本机 Web GUI：总览、文件列表、检索、按行读、重建任务、访问策略；
 * v1.2 新增 /access（当前会话的有效访问范围）与 POST /policy（面板内改权限）。
 * 路由由 plugin/lib/index.js 挂到 ctx.webServer 上；这里不直接依赖 Cordis，
 * 方便用假的 req/res 做单元测试。
 *
 * 安全边界：
 *   · 同源校验（拒绝跨站请求）；
 *   · 请求体上限 256 KiB；
 *   · 所有路径都走 engine 的 root 内校验；
 *   · 面板是“人看的管理视图”，可见全部语料；workspace/session 只用于计算
 *     ACL 视角与编辑策略。
 */
import { authorize, normalize } from './access.js'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { findPowerShell } from './pdf.js'
import {
  collectionNames,
  collectionStatus,
  listDocs,
  readFile,
  search,
} from './engine.js'
import {
  PolicyValidationError,
  policySummary,
  savePolicy,
} from './policy.js'
import { SUPPORTED_EXTENSIONS, extractorAvailability } from './extract.js'
import { migrateRoot, readRootState, rootStatePath } from './settings.js'
import { deleteCollection, deleteDocument } from './trash.js'

export { policySummary }

export const PANEL_PREFIX = '/api/dsh-plugin-corpus'
const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 解析一个 root 内的原件路径；越界/非法返回 null。 */
function resolveOriginalPath(root, relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/')
  const parts = rel.split('/')
  if (rel === '' || parts.some((part) => part === '' || part === '..') || !parts.includes('originals')) return null
  const rootAbs = path.resolve(root)
  const abs = path.resolve(rootAbs, rel)
  if (!(abs === rootAbs || abs.startsWith(rootAbs + path.sep))) return null
  let stat
  try { stat = fs.lstatSync(abs) } catch { return null }
  if (!stat.isFile() || stat.isSymbolicLink()) return null
  let real
  try { real = fs.realpathSync(abs) } catch { return null }
  const relReal = path.relative(fs.realpathSync(rootAbs), real)
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) return null
  return { rel, abs, stat }
}

function resolveCorpusFile(root, relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/')
  const parts = rel.split('/')
  if (rel === '' || parts.some((part) => part === '' || part === '..' || part === '.')) return null
  const rootAbs = path.resolve(root)
  const abs = path.resolve(rootAbs, rel)
  if (!(abs === rootAbs || abs.startsWith(rootAbs + path.sep))) return null
  let stat
  try { stat = fs.lstatSync(abs) } catch { return null }
  if (!stat.isFile() || stat.isSymbolicLink()) return null
  let real
  try { real = fs.realpathSync(abs) } catch { return null }
  const relReal = path.relative(fs.realpathSync(rootAbs), real)
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) return null
  return { rel, abs, stat }
}

function sendFileBuffer(res, contentType, buffer, options = {}) {
  res.statusCode = options.status || 200
  res.setHeader('content-type', contentType || 'application/octet-stream')
  res.setHeader('content-length', String(buffer.length))
  res.setHeader('cache-control', options.cacheControl || 'private, max-age=3600')
  res.end(buffer)
}

function runThumbnail(file, size, outFile) {
  return new Promise((resolve, reject) => {
    const powershell = findPowerShell()
    if (powershell === null) { reject(new Error('Windows PowerShell 不可用')); return }
    const script = path.join(HERE, 'thumb_windows.ps1')
    if (!fs.existsSync(script)) { reject(new Error('缺少 thumb_windows.ps1')); return }
    execFile(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Path', file, '-Size', String(size), '-OutFile', outFile], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000, windowsHide: true,
    }, (error, stdout) => {
      if (error) { reject(error); return }
      try { resolve(JSON.parse(String(stdout || '').trim())) } catch (parseError) { reject(parseError) }
    })
  })
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function fromAnotherSite(req) {
  const raw = req.headers.origin
  const origin = Array.isArray(raw) ? raw[0] || '' : raw || ''
  if (origin === '') return false
  try {
    const parsed = new URL(origin)
    const rawHost = req.headers.host
    const host = Array.isArray(rawHost) ? rawHost[0] || '' : rawHost || ''
    return host === '' || parsed.host !== host
  } catch {
    return true
  }
}

function readJson(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > maxBytes) {
        reject(new Error('请求体过大'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try { resolve(body.trim() === '' ? {} : JSON.parse(body)) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

function sumStats(collections) {
  return {
    collections: collections.length,
    docs: collections.reduce((sum, item) => sum + item.docs, 0),
    chunks: collections.reduce((sum, item) => sum + item.chunks, 0),
    bytes: collections.reduce((sum, item) => sum + item.bytes, 0),
    indexBytes: collections.reduce((sum, item) => sum + item.indexBytes, 0),
  }
}

function queryOf(req) {
  try { return new URL(req.url || '/', 'http://127.0.0.1').searchParams } catch { return new URLSearchParams() }
}

/** 给右栏面板的集合候选（名称/后端/文档数）。 */
function collectionChoices(root) {
  return collectionStatus(root).map((item) => ({
    name: item.name,
    backend: item.backend,
    docs: item.docs,
  }))
}

const IMAGE_MEDIA = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
}

function mediaTypeOf(file) {
  return IMAGE_MEDIA[path.extname(String(file || '')).toLowerCase()] || 'application/octet-stream'
}

function isImageFile(file) {
  return Object.prototype.hasOwnProperty.call(IMAGE_MEDIA, path.extname(String(file || '')).toLowerCase())
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/**
 * 扫描导入文件夹里的原件（每条导入一个文件夹：originals/ + processed/）。
 * 同时兼容 v1.2 的 <root>/.corpus/originals 旧布局。
 */
function listOriginals(root, collectionFilter = '') {
  const entries = []
  const names = collectionNames(root).filter((name) => collectionFilter === '' || name === collectionFilter)
  for (const collection of names) {
    const collectionDir = path.join(root, collection)
    let children = []
    try { children = fs.readdirSync(collectionDir, { withFileTypes: true }) } catch { children = [] }
    for (const child of children) {
      if (!child.isDirectory() || child.name.startsWith('.')) continue
      const folderDir = path.join(collectionDir, child.name)
      const originalsDir = path.join(folderDir, 'originals')
      if (!fs.existsSync(originalsDir)) continue
      const meta = readJsonFile(path.join(folderDir, '.meta.json'))
      let files = []
      try { files = fs.readdirSync(originalsDir, { withFileTypes: true }).filter((item) => item.isFile() && !item.name.startsWith('.')) } catch { files = [] }
      for (const file of files) {
        const abs = path.join(originalsDir, file.name)
        let stat = null
        try { stat = fs.statSync(abs) } catch { continue }
        entries.push({
          collection,
          folder: child.name,
          name: file.name,
          original: path.posix.join(collection, child.name, 'originals', file.name),
          processed: meta && typeof meta.processed === 'string' ? meta.processed : null,
          title: meta && typeof meta.title === 'string' ? meta.title : file.name,
          format: path.extname(file.name).slice(1).toLowerCase(),
          mediaType: mediaTypeOf(file.name),
          image: isImageFile(file.name),
          bytes: stat.size,
          mtimeMs: stat.mtimeMs,
          importedAt: meta && typeof meta.importedAt === 'string' ? meta.importedAt : new Date(stat.mtimeMs).toISOString(),
          aiStructured: Boolean(meta && meta.aiStructured),
        })
      }
    }
  }
  // 旧布局兼容：<root>/.corpus/originals/<collection>/<file>
  if (collectionFilter === '') {
    for (const collection of names) {
      const oldDir = path.join(root, '.corpus', 'originals', collection)
      let files = []
      try { files = fs.readdirSync(oldDir, { withFileTypes: true }).filter((item) => item.isFile() && !item.name.startsWith('.')) } catch { files = [] }
      for (const file of files) {
        const abs = path.join(oldDir, file.name)
        let stat = null
        try { stat = fs.statSync(abs) } catch { continue }
        entries.push({
          collection,
          folder: null,
          name: file.name,
          original: path.posix.join('.corpus', 'originals', collection, file.name),
          processed: null,
          title: file.name,
          format: path.extname(file.name).slice(1).toLowerCase(),
          mediaType: mediaTypeOf(file.name),
          image: isImageFile(file.name),
          bytes: stat.size,
          mtimeMs: stat.mtimeMs,
          importedAt: new Date(stat.mtimeMs).toISOString(),
          aiStructured: false,
        })
      }
    }
  }
  entries.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return entries
}

const THUMBNAIL_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.pdf', '.docx', '.xlsx', '.pptx'])

function stripFrontMatterText(text) {
  const value = String(text || '')
  const match = value.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return match ? value.slice(match[0].length) : value
}

function readExcerpt(root, relPath, limit = 260) {
  try {
    const abs = path.resolve(root, ...String(relPath).split('/'))
    const rootAbs = path.resolve(root)
    if (!abs.startsWith(rootAbs + path.sep)) return ''
    const text = stripFrontMatterText(fs.readFileSync(abs, 'utf8'))
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[`*_>#|-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return text.slice(0, limit)
  } catch {
    return ''
  }
}

/**
 * 语料缩略图：以 processed 文档为主，关联它导入时的原件缩略图。
 * 没有原件的旧版文本语料用 excerpt 文本预览代表。
 */
function listGallery(root, collectionFilter = '', limit = 60) {
  const names = collectionNames(root).filter((name) => collectionFilter === '' || name === collectionFilter)
  const items = []
  for (const collection of names) {
    let listed = null
    try { listed = listDocs(root, { collections: [collection], limit: 1000 }) } catch { listed = null }
    if (!listed || !Array.isArray(listed.collections)) continue
    for (const group of listed.collections) {
      const indexedAt = group.indexedAt || null
      for (const file of Array.isArray(group.files) ? group.files : []) {
        const parts = String(file.path || '').split('/')
        const processedIndex = parts.indexOf('processed')
        let meta = null
        if (processedIndex > 1) {
          const folderRel = parts.slice(0, processedIndex).join('/')
          meta = readJsonFile(path.join(root, ...folderRel.split('/'), '.meta.json'))
        }
        const original = meta && typeof meta.original === 'string' ? meta.original : null
        let originalExists = false
        let originalBytes = 0
        let originalMtime = 0
        if (original) {
          try {
            const abs = path.resolve(root, ...original.split('/'))
            const stat = fs.statSync(abs)
            if (stat.isFile()) {
              originalExists = true
              originalBytes = stat.size
              originalMtime = stat.mtimeMs
            }
          } catch { originalExists = false }
        }
        const originalExt = original ? path.extname(original).toLowerCase() : ''
        const thumbnail = originalExists && THUMBNAIL_EXTS.has(originalExt)
          ? `${PANEL_PREFIX}/thumbnail?path=${encodeURIComponent(original)}&size=320`
          : null
        let processedMtime = 0
        try { processedMtime = fs.statSync(path.resolve(root, ...String(file.path).split('/'))).mtimeMs } catch { processedMtime = 0 }
        const importedAt = meta && typeof meta.importedAt === 'string' && meta.importedAt !== ''
          ? meta.importedAt
          : new Date(originalMtime || processedMtime || Date.now()).toISOString()
        items.push({
          collection,
          path: file.path,
          title: meta && typeof meta.title === 'string' && meta.title !== '' ? meta.title : file.title,
          excerpt: readExcerpt(root, file.path),
          format: meta && typeof meta.format === 'string' && meta.format !== '' ? meta.format : (path.extname(file.path).slice(1) || 'text'),
          bytes: originalExists ? originalBytes : Number(file.bytes) || 0,
          chunks: Number(file.chunks) || 0,
          indexedAt,
          importedAt,
          original: originalExists ? original : null,
          thumbnail,
          aiStructured: Boolean(meta && meta.aiStructured),
          kind: meta && typeof meta.kind === 'string' ? meta.kind : 'text',
        })
      }
    }
  }
  items.sort((left, right) => {
    const leftTime = Date.parse(left.importedAt) || 0
    const rightTime = Date.parse(right.importedAt) || 0
    return rightTime - leftTime
  })
  const total = items.length
  return { total, items: items.slice(0, Math.max(1, Math.min(1000, Number(limit) || 60))) }
}

/**
 * 构造面板路由表。
 * @param root - 语料根。
 * @param dshHome - DSH_HOME（策略文件所在处）。
 * @param jobs - createJobRunner 的返回值。
 * @param sessionLookup - (id) => { id, workspace } | null；index.js 用 ctx.sessions 实现。
 * @param ingest - createIngestManager 的返回值。
 * @returns [{kind:'exact', path, handler}]
 */
export function createPanelRoutes({ root, dshHome, jobs, sessionLookup, ingest }) {
  const guarded = (handler) => async (req, res) => {
    if (fromAnotherSite(req)) {
      sendJson(res, 403, { ok: false, error: '拒绝跨站请求' })
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const routes = []

  routes.push({
    kind: 'exact',
    path: `${PANEL_PREFIX}/overview`,
    handler: guarded(async (req, res) => {
      if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const collections = collectionStatus(root)
      sendJson(res, 200, {
        ok: true,
        root,
        stats: sumStats(collections),
        collections,
        policy: policySummary(dshHome),
      })
    }),
  })

  routes.push({
    kind: 'exact',
    path: `${PANEL_PREFIX}/files`,
    handler: guarded(async (req, res) => {
      if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const collection = queryOf(req).get('collection') || ''
      if (collection === '' || !collectionNames(root).includes(collection)) {
        sendJson(res, 404, { ok: false, error: `没有集合 ${collection}` })
        return
      }
      const listed = listDocs(root, { collections: [collection], limit: 1000 })
      const first = listed.collections[0] || { docs: 0, files: [] }
      sendJson(res, 200, { ok: true, collection, total: first.docs, files: first.files })
    }),
  })

  routes.push({
    kind: 'exact',
    path: `${PANEL_PREFIX}/search`,
    handler: guarded(async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const body = await readJson(req)
      const query = typeof body.query === 'string' ? body.query : ''
      if (query.trim() === '') { sendJson(res, 400, { ok: false, error: 'query 不能为空' }); return }
      const all = collectionNames(root)
      let names = Array.isArray(body.collections) && body.collections.length > 0
        ? body.collections.filter((name) => all.includes(name))
        : all
      const workspace = typeof body.workspace === 'string' && body.workspace.trim() !== '' ? body.workspace : ''
      if (workspace !== '') {
        const auth = authorize(dshHome, { workspace, session: '' }, all)
        const allowed = new Set(auth.allowedCollections)
        names = names.filter((name) => allowed.has(name))
      }
      if (names.length === 0) {
        sendJson(res, 200, { ok: true, query, terms: [], collections: [], hits: [], scope: { workspace, collections: [] } })
        return
      }
      const result = search(root, { collections: names, query, limit: Number(body.limit) || 8 })
      sendJson(res, 200, { ...result, scope: { workspace, collections: names } })
    }),
  })

  routes.push({
    kind: 'exact',
    path: `${PANEL_PREFIX}/read`,
    handler: guarded(async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const body = await readJson(req)
      if (typeof body.path !== 'string' || body.path === '') {
        sendJson(res, 400, { ok: false, error: '缺少 path' })
        return
      }
      sendJson(res, 200, readFile(root, body.path, { from: body.from, lines: body.lines }))
    }),
  })

  routes.push({
    kind: 'exact',
    path: `${PANEL_PREFIX}/reindex`,
    handler: guarded(async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const body = await readJson(req)
      const force = body.force === true
      let names = []
      if (typeof body.collection === 'string' && body.collection !== '') {
        if (!collectionNames(root).includes(body.collection)) {
          sendJson(res, 404, { ok: false, error: `没有集合 ${body.collection}` })
          return
        }
        names = [body.collection]
      }
      sendJson(res, 200, { ok: true, ...jobs.start({ names, force }) })
    }),
  })

  routes.push({
    kind: 'exact',
    path: `${PANEL_PREFIX}/status`,
    handler: guarded(async (req, res) => {
      if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      sendJson(res, 200, { ok: true, ...jobs.status(), collections: collectionStatus(root) })
    }),
  })

  // v1.2：当前会话的有效访问范围 + 策略原文（供右栏权限面板渲染/编辑）。
  routes.push({
    kind: 'exact',
    path: `${PANEL_PREFIX}/access`,
    handler: guarded(async (req, res) => {
      if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const query = queryOf(req)
      const sessionId = query.get('session') || ''
      const fallbackWorkspace = query.get('workspace') || ''
      let looked = null
      try { looked = typeof sessionLookup === 'function' ? sessionLookup(sessionId) : null } catch { looked = null }
      const workspace = (looked && typeof looked.workspace === 'string' && looked.workspace !== '')
        ? looked.workspace
        : fallbackWorkspace
      const names = collectionNames(root)
      const auth = authorize(dshHome, { workspace, session: sessionId }, names)
      sendJson(res, 200, {
        ok: true,
        sessionId: looked && looked.id ? looked.id : sessionId,
        workspace,
        workspaceKey: normalize(workspace),
        effectiveCollections: auth.allowedCollections,
        collections: collectionChoices(root),
        policy: policySummary(dshHome),
      })
    }),
  })

  // v1.3：导入原件列表（管理页缩略图）与原件字节读取。
  routes.push({
    kind: 'exact',
    path: `${PANEL_PREFIX}/originals`,
    handler: guarded(async (req, res) => {
      if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const collection = queryOf(req).get('collection') || ''
      const entries = listOriginals(root, collection)
      sendJson(res, 200, {
        ok: true,
        total: entries.length,
        collections: collectionChoices(root),
        imports: entries,
      })
    }),
  })

  routes.push({
    kind: 'exact',
    path: `${PANEL_PREFIX}/original`,
    handler: guarded(async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const rel = String(queryOf(req).get('path') || '').replace(/\\/g, '/')
      const parts = rel.split('/')
      if (rel === '' || parts.some((part) => part === '' || part === '..') || !parts.includes('originals')) {
        sendJson(res, 400, { ok: false, error: 'path 必须是原件路径' })
        return
      }
      const rootAbs = path.resolve(root)
      const abs = path.resolve(rootAbs, rel)
      if (!(abs === rootAbs || abs.startsWith(rootAbs + path.sep))) {
        sendJson(res, 403, { ok: false, error: '路径越界' })
        return
      }
      let stat
      try { stat = fs.lstatSync(abs) } catch { sendJson(res, 404, { ok: false, error: '找不到原件' }); return }
      if (!stat.isFile() || stat.isSymbolicLink()) { sendJson(res, 404, { ok: false, error: '不是可读取的原件' }); return }
      let real
      try { real = fs.realpathSync(abs) } catch { sendJson(res, 404, { ok: false, error: '找不到原件' }); return }
      const relReal = path.relative(fs.realpathSync(rootAbs), real)
      if (relReal.startsWith('..') || path.isAbsolute(relReal)) { sendJson(res, 403, { ok: false, error: '路径越界' }); return }
      res.statusCode = 200
      res.setHeader('content-type', mediaTypeOf(abs))
      res.setHeader('content-length', String(stat.size))
      res.setHeader('cache-control', 'private, max-age=3600')
      if (req.method === 'HEAD') { res.end(); return }
      fs.createReadStream(abs).pipe(res)
    }),
  })

  // v1.3：Windows 缩略图（所有文件类型；逻辑由 Windows 提供，插件只调用）。
  routes.push({
    kind: 'exact',
    path: `${PANEL_PREFIX}/thumbnail`,
    handler: guarded(async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const query = queryOf(req)
      const resolved = resolveOriginalPath(root, query.get('path') || '')
      if (resolved === null) { sendJson(res, 400, { ok: false, error: 'path 必须是原件路径' }); return }
      const size = Math.max(64, Math.min(512, Number(query.get('size')) || 256))
      const thumbsDir = path.join(root, '.corpus', 'thumbs')
      fs.mkdirSync(thumbsDir, { recursive: true })
      const key = crypto.createHash('sha1')
        .update(`${resolved.rel}|${size}|${resolved.stat.mtimeMs}`)
        .digest('hex')
      const cacheImage = path.join(thumbsDir, key + '.img')
      const cacheMeta = path.join(thumbsDir, key + '.json')
      const serveCached = () => {
        const meta = readJsonFile(cacheMeta) || {}
        const buffer = fs.readFileSync(cacheImage)
        res.statusCode = 200
        res.setHeader('content-type', meta.contentType || 'image/bmp')
        res.setHeader('content-length', String(buffer.length))
        res.setHeader('cache-control', 'private, max-age=86400')
        if (req.method === 'HEAD') { res.end(); return }
        res.end(buffer)
      }
      if (fs.existsSync(cacheImage) && fs.existsSync(cacheMeta)) {
        try { serveCached(); return } catch { /* 缓存损坏则重生成 */ }
      }
      const temp = path.join(thumbsDir, key + '.tmp-' + process.pid + '-' + Date.now())
      try {
        const info = await runThumbnail(resolved.abs, size, temp)
        if (!info || info.ok !== true || !fs.existsSync(temp)) throw new Error('Windows 没有返回缩略图')
        const buffer = fs.readFileSync(temp)
        const contentType = typeof info.contentType === 'string' && info.contentType !== '' ? info.contentType : 'image/bmp'
        fs.writeFileSync(cacheImage, buffer)
        fs.writeFileSync(cacheMeta, JSON.stringify({ contentType, width: info.width, height: info.height }, null, 2), 'utf8')
        try { fs.rmSync(temp, { force: true }) } catch { /* 清理失败不影响结果 */ }
        res.statusCode = 200
        res.setHeader('content-type', contentType)
        res.setHeader('content-length', String(buffer.length))
        res.setHeader('cache-control', 'private, max-age=86400')
        if (req.method === 'HEAD') { res.end(); return }
        res.end(buffer)
      } catch (error) {
        try { fs.rmSync(temp, { force: true }) } catch { /* 清理失败不影响回退 */ }
        // 图片可以退回原图；其他类型让前端显示类型图标。
        if (isImageFile(resolved.abs)) {
          try {
            const buffer = fs.readFileSync(resolved.abs)
            sendFileBuffer(res, mediaTypeOf(resolved.abs), buffer)
            return
          } catch { /* 继续 404 */ }
        }
        sendJson(res, 404, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }),
  })

  // v1.3：导入 UI 的候选集合、格式与提取器状态。
  routes.push({
    kind: 'exact',
    path: `${PANEL_PREFIX}/import/targets`,
    handler: guarded(async (req, res) => {
      if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const collections = collectionStatus(root).map((item) => ({
        name: item.name,
        backend: item.backend,
        docs: item.docs,
      }))
      let visionStatus = { available: false, reason: '摄取小代理不可用' }
      if (ingest && typeof ingest.visionStatus === 'function') {
        visionStatus = await ingest.visionStatus()
      } else if (ingest && typeof ingest.visionAvailable === 'function') {
        try {
          visionStatus = { available: (await ingest.visionAvailable()) === true, reason: '旧版摄取服务没有能力诊断' }
        } catch {
          visionStatus = { available: false, reason: '无法读取视觉能力' }
        }
      }
      sendJson(res, 200, {
        ok: true,
        collections,
        formats: SUPPORTED_EXTENSIONS,
        extractors: extractorAvailability(),
        aiAvailable: Boolean(ingest && typeof ingest.aiAvailable === 'function' && ingest.aiAvailable()),
        visionAvailable: visionStatus.available === true,
        visionStatus,
        limits: ingest && ingest.limits ? ingest.limits : { maxFiles: 200, maxUploadBytes: 25 * 1024 * 1024 },
      })
    }),
  })

  // v1.3：启动一个导入任务（本机路径或浏览器上传的 base64 文件）。
  routes.push({
    kind: 'exact',
    path: `${PANEL_PREFIX}/import`,
    handler: guarded(async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      if (!ingest || typeof ingest.start !== 'function') {
        sendJson(res, 503, { ok: false, error: '导入服务不可用' })
        return
      }
      const body = await readJson(req, 48 * 1024 * 1024)
      const files = Array.isArray(body.files) ? body.files : []
      const paths = Array.isArray(body.paths)
        ? body.paths
        : (typeof body.path === 'string' && body.path !== '' ? [body.path] : [])
      try {
        const result = ingest.start({
          paths,
          uploads: files,
          collection: typeof body.collection === 'string' ? body.collection : '',
          prefix: typeof body.prefix === 'string' ? body.prefix : '',
          ai: body.ai !== false,
          index: body.index !== false,
        })
        if (result.started) sendJson(res, 200, { ok: true, ...result })
        else sendJson(res, 200, { ok: false, started: false, busy: true, job: result.job })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }),
  })

  // v1.3：导入任务状态（面板轮询）。
  routes.push({
    kind: 'exact',
    path: `${PANEL_PREFIX}/import/status`,
    handler: guarded(async (req, res) => {
      if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      if (!ingest || typeof ingest.status !== 'function') {
        sendJson(res, 200, { ok: true, active: null, recent: [] })
        return
      }
      sendJson(res, 200, { ok: true, ...ingest.status() })
    }),
  })

  // v1.7：删除单篇语料或整个集合（软删除到 .corpus/trash）。
  routes.push({
    kind: 'exact',
    path: `${PANEL_PREFIX}/delete`,
    handler: guarded(async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      let activeJob = null
      let activeIngest = null
      try { activeJob = jobs && typeof jobs.status === 'function' ? jobs.status().active : null } catch { activeJob = null }
      try { activeIngest = ingest && typeof ingest.status === 'function' ? ingest.status().active : null } catch { activeIngest = null }
      if (activeJob !== null || activeIngest !== null) {
        sendJson(res, 409, { ok: false, error: '还有导入/重建任务在运行，等任务结束后再删除语料', busy: true })
        return
      }
      const body = await readJson(req, 256 * 1024)
      const relPath = typeof body.path === 'string' ? body.path.trim() : ''
      const collection = typeof body.collection === 'string' ? body.collection.trim() : ''
      if ((relPath === '') === (collection === '')) {
        sendJson(res, 400, { ok: false, error: 'path 与 collection 必须二选一' })
        return
      }
      try {
        if (relPath !== '') {
          const result = deleteDocument(root, relPath)
          let reindexJobId = null
          try {
            const started = jobs.start({ names: [result.collection] })
            reindexJobId = started && started.job ? started.job.id : null
          } catch { reindexJobId = null }
          sendJson(res, 200, { ok: true, ...result, reindexJobId, hint: '已移到 .corpus/trash，可人工恢复' })
          return
        }
        const result = deleteCollection(root, collection)
        sendJson(res, 200, { ok: true, ...result, hint: '集合同样移到 .corpus/trash/collections，可人工恢复' })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }),
  })

  // v1.6：语料缩略图（processed 文档 + 原件缩略图/文本摘要）。
  routes.push({
    kind: 'exact',
    path: `${PANEL_PREFIX}/gallery`,
    handler: guarded(async (req, res) => {
      if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const query = queryOf(req)
      const collection = query.get('collection') || ''
      const limit = Math.max(1, Math.min(1000, Number(query.get('limit')) || 100))
      // listGallery 内部对 collection 做过滤；未知集合会得到空结果。
      sendJson(res, 200, { ok: true, collection, limit, ...listGallery(root, collection, limit) })
    }),
  })

  // v1.5：语料库根目录设置与迁移。
  routes.push({
    kind: 'exact',
    path: `${PANEL_PREFIX}/settings`,
    handler: guarded(async (req, res) => {
      if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const state = readRootState(dshHome)
      const effectiveRoot = state !== null && fs.existsSync(state.root) ? state.root : root
      let exists = false
      let writable = false
      try {
        exists = fs.statSync(effectiveRoot).isDirectory()
        fs.accessSync(effectiveRoot, fs.constants.W_OK)
        writable = true
      } catch { /* 不存在/不可写 */ }
      let activeJob = null
      let activeIngest = null
      try { activeJob = jobs && typeof jobs.status === 'function' ? jobs.status().active : null } catch { activeJob = null }
      try { activeIngest = ingest && typeof ingest.status === 'function' ? ingest.status().active : null } catch { activeIngest = null }
      sendJson(res, 200, {
        ok: true,
        root: effectiveRoot,
        runtimeRoot: root,
        stateFile: rootStatePath(dshHome),
        state,
        exists,
        writable,
        busy: activeJob !== null || activeIngest !== null,
        activeJob,
        activeIngest,
        collections: collectionNames(root).length,
      })
    }),
  })

  routes.push({
    kind: 'exact',
    path: `${PANEL_PREFIX}/settings/root`,
    handler: guarded(async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      let activeJob = null
      let activeIngest = null
      try { activeJob = jobs && typeof jobs.status === 'function' ? jobs.status().active : null } catch { activeJob = null }
      try { activeIngest = ingest && typeof ingest.status === 'function' ? ingest.status().active : null } catch { activeIngest = null }
      if (activeJob !== null || activeIngest !== null) {
        sendJson(res, 409, { ok: false, error: '还有导入/重建任务在运行，等任务结束后再迁移语料库', busy: true })
        return
      }
      const body = await readJson(req, 256 * 1024)
      try {
        const result = migrateRoot({ dshHome, currentRoot: root, newRoot: String(body.root || '') })
        sendJson(res, 200, { ok: true, ...result, stateFile: rootStatePath(dshHome) })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }),
  })

  routes.push({
    kind: 'exact',
    path: `${PANEL_PREFIX}/settings/open`,
    handler: guarded(async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const state = readRootState(dshHome)
      const effectiveRoot = state !== null && fs.existsSync(state.root) ? state.root : root
      if (!fs.existsSync(effectiveRoot)) { sendJson(res, 404, { ok: false, error: '语料库根目录不存在' }); return }
      if (process.platform !== 'win32') { sendJson(res, 501, { ok: false, error: '打开文件夹只支持 Windows' }); return }
      try {
        execFile('explorer.exe', [effectiveRoot], { windowsHide: true }, () => {})
        sendJson(res, 200, { ok: true, root: effectiveRoot })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }),
  })

  // 用 Windows 默认关联程序打开 processed/原件。
  routes.push({
    kind: 'exact',
    path: `${PANEL_PREFIX}/open-external`,
    handler: guarded(async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      if (process.platform !== 'win32') { sendJson(res, 501, { ok: false, error: '外部打开只支持 Windows' }); return }
      const body = await readJson(req)
      const resolved = resolveCorpusFile(root, body && body.path)
      if (resolved === null) { sendJson(res, 400, { ok: false, error: 'path 必须是语料根内的文件' }); return }
      const powershell = findPowerShell()
      const mode = body && body.mode === 'choose' ? 'choose' : 'default'
      if (powershell === null) {
        sendJson(res, 500, { ok: false, error: 'Windows PowerShell 不可用' }); return
      }
      try {
        if (mode === 'choose') {
          // Windows「打开方式」对话框；用户选择已安装的软件。
          execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command',
            "Start-Process -FilePath rundll32.exe -ArgumentList 'shell32.dll,OpenAs_RunDLL', $env:DSH_CORPUS_OPEN_FILE"], {
            windowsHide: true,
            env: { ...process.env, DSH_CORPUS_OPEN_FILE: resolved.abs },
          }, () => {})
        } else {
          // 通过环境变量传路径，避免路径中的空格/引号进入命令行字符串。
          // Start-Process 使用 Windows 文件关联，比 rundll32 url.dll 更可靠。
          execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command',
            'Start-Process -FilePath $env:DSH_CORPUS_OPEN_FILE'], {
            windowsHide: true,
            env: { ...process.env, DSH_CORPUS_OPEN_FILE: resolved.abs },
          }, () => {})
        }
        sendJson(res, 200, { ok: true, path: resolved.rel, mode })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }),
  })

  // v1.2：读策略；POST 保存（面板内编辑权限）。
  routes.push({
    kind: 'exact',
    path: `${PANEL_PREFIX}/policy`,
    handler: guarded(async (req, res) => {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, ...policySummary(dshHome) })
        return
      }
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const body = await readJson(req)
      const input = body && typeof body === 'object' && body.policy && typeof body.policy === 'object'
        ? body.policy
        : body
      try {
        const saved = savePolicy(dshHome, input)
        sendJson(res, 200, {
          ok: true,
          policy: policySummary(dshHome),
          accessFile: saved.accessFile,
          backup: saved.backup,
        })
      } catch (error) {
        if (error instanceof PolicyValidationError) {
          sendJson(res, 400, { ok: false, error: '策略校验失败', errors: error.errors })
          return
        }
        throw error
      }
    }),
  })

  return routes
}
