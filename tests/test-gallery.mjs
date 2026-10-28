// dsh-plugin-corpus — 语料文件列表 API 验收（自包含）。
//
// 覆盖：/gallery 只列 processed 文档、collection 过滤与 limit、未知集合空结果、非 GET 405。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createPanelRoutes } from '../plugin/lib/panel.js'

let pass = 0
const ok = (label) => { pass++; console.log('  PASS ' + label) }
const assert = (condition, message) => { if (!condition) throw new Error('ASSERT: ' + message) }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-gallery-'))
const root = path.join(tmp, 'corpus')
const home = path.join(tmp, 'home')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(path.join(root, 'alpha'), { recursive: true })
fs.writeFileSync(path.join(root, 'alpha', 'legacy.md'), '# Legacy Doc\n\n这是一篇旧版平铺语料。\n')

const folder = path.join(root, 'alpha', '20261026-220000-photo')
fs.mkdirSync(path.join(folder, 'processed'), { recursive: true })
fs.writeFileSync(path.join(folder, 'processed', 'photo.md'), '# Photo Doc\n\n从图片导入的结构化语料。\n')
fs.writeFileSync(path.join(folder, '.meta.json'), JSON.stringify({
  version: 1,
  collection: 'alpha',
  folder: '20261026-220000-photo',
  source: 'photo.png',
  processed: 'alpha/20261026-220000-photo/processed/photo.md',
  title: 'Photo Doc',
  format: 'md',
  importedAt: '2026-10-26T14:00:00.000Z',
  aiStructured: true,
}, null, 2))

try {
  const routes = createPanelRoutes({
    root,
    dshHome: home,
    jobs: { status: () => ({ active: null, recent: [] }) },
    sessionLookup: () => null,
    ingest: { status: () => ({ active: null, recent: [] }), limits: { maxFiles: 200, maxUploadBytes: 1024 } },
  })
  assert(routes.length === 19, '面板路由 19 条，实际 ' + routes.length)
  const route = routes.find((item) => item.path === '/api/dsh-plugin-corpus/gallery')
  assert(route !== undefined, '存在 /gallery 路由')
  const invoke = (url, method = 'GET') => new Promise((resolve, reject) => {
    const req = Readable.from([])
    req.method = method
    req.url = url
    req.headers = { host: '127.0.0.1:1' }
    const res = { statusCode: 0, setHeader() {}, end(value) { resolve({ status: this.statusCode, text: String(value || '') }) } }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })

  const { createJobRunner } = await import('../plugin/lib/jobs.js')
  const jobs = createJobRunner({ root })
  try {
    const started = jobs.start({ names: ['alpha'], force: true })
    assert(started.started === true, '启动临时索引重建')
    for (let wait = 0; wait < 100; wait += 1) {
      if (!jobs.status().active) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert(!jobs.status().active, '临时索引重建结束')
  } finally {
    try { jobs.dispose() } catch { /* ignore */ }
  }

  const all = await invoke('/api/dsh-plugin-corpus/gallery?limit=10')
  const body = JSON.parse(all.text)
  assert(all.status === 200 && body.ok === true && body.total === 2, '/gallery 返回两篇语料: ' + all.text)
  assert(body.limit === 10 && body.collection === '', '回显 limit/collection：' + all.text)
  const defaults = await invoke('/api/dsh-plugin-corpus/gallery')
  const defaultsBody = JSON.parse(defaults.text)
  assert(defaults.status === 200 && defaultsBody.limit === 100, '/gallery 默认 limit=100：' + defaults.text)
  assert(defaultsBody.total === 2 && defaultsBody.items.length === 2, '默认请求返回两篇：' + defaults.text)
  const capped = await invoke('/api/dsh-plugin-corpus/gallery?limit=5000')
  assert(capped.status === 200 && JSON.parse(capped.text).limit === 1000, 'limit 夹到上限 1000：' + capped.text)
  const zero = await invoke('/api/dsh-plugin-corpus/gallery?limit=0')
  assert(zero.status === 200 && JSON.parse(zero.text).limit === 100, 'limit=0 回落默认 100：' + zero.text)
  const legacy = body.items.find((item) => item.path === 'alpha/legacy.md')
  const photo = body.items.find((item) => item.path.endsWith('/processed/photo.md'))
  assert(body.items.length === 2, '返回全部两条 items：' + all.text)
  assert(legacy && legacy.kind === 'text' && legacy.format === 'md', '纯文本 kind=text/format=md')
  assert(legacy.aiStructured === false, '纯文本不是 AI 结构化')
  assert(typeof legacy.indexedAt === 'string' && legacy.indexedAt !== '', '带 indexedAt：' + JSON.stringify(legacy))
  assert(typeof legacy.chunks === 'number' && legacy.chunks >= 1, '带 chunks 数')
  assert(legacy.original === undefined && legacy.thumbnail === undefined, '不再返回 original/thumbnail')
  assert(photo && photo.title === 'Photo Doc' && photo.aiStructured === true, '读取 .meta.json 标题/AI 标记')
  assert(photo.format === 'md' && typeof photo.bytes === 'number' && photo.bytes > 0, 'format/bytes 取 processed 文件')
  assert(photo.original === undefined && photo.thumbnail === undefined, 'processed 条目没有原件/缩略图字段')
  assert(photo.excerpt.includes('从图片导入的结构化语料'), 'processed 正文仍返回 excerpt')
  ok('/gallery：只列 processed 文档、limit 默认 100/上限 1000、无原件/缩略图')

  const filtered = await invoke('/api/dsh-plugin-corpus/gallery?collection=alpha&limit=1')
  const filteredBody = JSON.parse(filtered.text)
  assert(filtered.status === 200 && filteredBody.ok === true, '/gallery 过滤请求成功')
  assert(filteredBody.total === 2 && filteredBody.items.length === 1, 'collection 过滤 + limit')
  assert(filteredBody.limit === 1 && filteredBody.collection === 'alpha' && filteredBody.items[0].collection === 'alpha',
    '回显 collection/limit 且条目属于该集合')
  const unknown = await invoke('/api/dsh-plugin-corpus/gallery?collection=nope')
  const unknownBody = JSON.parse(unknown.text)
  assert(unknown.status === 200 && unknownBody.total === 0 && unknownBody.items.length === 0, '未知集合返回空结果')
  const post = await invoke('/api/dsh-plugin-corpus/gallery', 'POST')
  assert(post.status === 405, '非 GET 返回 405，实际 ' + post.status)
  ok('/gallery：collection 过滤 + limit')

  console.log('\n全部通过: ' + pass + ' 项（语料文件列表 API）')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
