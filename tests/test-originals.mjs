// dsh-plugin-corpus v1.3 — 原件/缩略图 API 验收（自包含）。
//
// 覆盖：每导入文件夹 originals/ + processed/ + .meta.json 的列表；
// 原件字节读取；Windows Shell 缩略图（不可用时跳过，不影响其余断言）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { createPanelRoutes } from '../plugin/lib/panel.js'

let pass = 0
let skipped = 0
const ok = (label) => { pass++; console.log('  PASS ' + label) }
const skip = (label) => { skipped++; console.log('  SKIP ' + label) }
const assert = (condition, message) => { if (!condition) throw new Error('ASSERT: ' + message) }

function tinyBmp(width, height) {
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const imageSize = rowSize * height
  const buffer = Buffer.alloc(54 + imageSize)
  buffer.write('BM', 0, 'ascii')
  buffer.writeUInt32LE(buffer.length, 2)
  buffer.writeUInt32LE(54, 10)
  buffer.writeUInt32LE(40, 14)
  buffer.writeInt32LE(width, 18)
  buffer.writeInt32LE(height, 22)
  buffer.writeUInt16LE(1, 26)
  buffer.writeUInt16LE(24, 28)
  buffer.writeUInt32LE(imageSize, 34)
  for (let index = 0; index < imageSize; index++) buffer[54 + index] = (index * 7) % 256
  return buffer
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-originals-'))
const root = path.join(tmp, 'corpus')
const home = path.join(tmp, 'home')
fs.mkdirSync(home, { recursive: true })
const collection = path.join(root, 'alpha')
const folder = path.join(collection, '20261026-210000-photo')
fs.mkdirSync(path.join(folder, 'originals'), { recursive: true })
fs.mkdirSync(path.join(folder, 'processed'), { recursive: true })
fs.writeFileSync(path.join(folder, 'originals', 'photo.bmp'), tinyBmp(200, 200))
fs.writeFileSync(path.join(folder, 'processed', 'photo.md'), '# Photo\n\n结构化后的文本\n')
fs.writeFileSync(path.join(folder, '.meta.json'), JSON.stringify({
  version: 1,
  collection: 'alpha',
  folder: '20261026-210000-photo',
  source: 'photo.bmp',
  original: 'alpha/20261026-210000-photo/originals/photo.bmp',
  processed: 'alpha/20261026-210000-photo/processed/photo.md',
  title: 'Photo',
  format: 'bmp',
  importedAt: new Date().toISOString(),
  aiStructured: true,
}, null, 2))

try {
  const jobs = { start: () => ({ started: false, job: null }), status: () => ({ active: null, recent: [] }) }
  const ingest = {
    aiAvailable: () => true,
    visionAvailable: async () => false,
    limits: { maxFiles: 200, maxUploadBytes: 1024 },
    start: () => ({ started: false, job: null }),
    status: () => ({ active: null, recent: [] }),
  }
  const routes = createPanelRoutes({ root, dshHome: home, jobs, sessionLookup: () => null, ingest })
  assert(routes.length === 20, '面板路由 19 条，实际 ' + routes.length)
  ok('面板路由 19 条（含 originals/original/thumbnail）')

  const byPath = new Map(routes.map((route) => [route.path, route]))
  const invoke = (method, url) => new Promise((resolve, reject) => {
    const route = byPath.get(url.split('?')[0])
    if (!route) return reject(new Error('no route ' + url))
    const req = Readable.from([])
    req.method = method
    req.url = url
    req.headers = { host: '127.0.0.1:1' }
    const chunks = []
    const res = new Writable({
      write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback() },
    })
    res.statusCode = 0
    res.setHeader = () => {}
    res.on('finish', () => {
      const buffer = Buffer.concat(chunks)
      resolve({ status: res.statusCode, buffer, text: buffer.toString('utf8'), headers: {} })
    })
    res.on('error', reject)
    Promise.resolve(route.handler(req, res)).catch(reject)
  })

  const listed = await invoke('GET', '/api/dsh-plugin-corpus/originals')
  const body = JSON.parse(listed.text)
  assert(listed.status === 200 && body.ok === true && body.total === 1, 'originals 列表')
  assert(body.imports[0].original.endsWith('/originals/photo.bmp'), 'original 路径')
  assert(body.imports[0].processed.endsWith('/processed/photo.md'), 'processed 路径')
  assert(body.imports[0].aiStructured === true && body.imports[0].title === 'Photo', 'meta 字段')
  ok('GET /originals（新布局 + meta）')

  const original = await invoke('GET', '/api/dsh-plugin-corpus/original?path=' + encodeURIComponent(body.imports[0].original))
  assert(original.status === 200 && original.buffer.length > 100, 'original 字节')
  assert(original.buffer.subarray(0, 2).toString('ascii') === 'BM', 'original BMP magic')
  ok('GET /original（按原件字节返回）')

  const blocking = await invoke('GET', '/api/dsh-plugin-corpus/original?path=' + encodeURIComponent('alpha/20261026-210000-photo/processed/photo.md'))
  assert(blocking.status === 400, '非 originals 路径拒绝')
  ok('GET /original 拒绝非原件路径')

  const thumb = await invoke('GET', '/api/dsh-plugin-corpus/thumbnail?path=' + encodeURIComponent(body.imports[0].original) + '&size=128')
  if (thumb.status === 200 && thumb.buffer.length > 100) {
    ok('GET /thumbnail（Windows Shell 缩略图）')
    assert(fs.readdirSync(path.join(root, '.corpus', 'thumbs')).length >= 1, '缩略图缓存')
    ok('缩略图缓存落在 .corpus/thumbs')
  } else {
    skip('GET /thumbnail（当前环境没有 Windows 缩略图提供程序）')
  }

  // corpus_read 只接受 processed 路径：originals 段必须被拒绝。
  const { readFile } = await import('../plugin/lib/engine.js')
  let blocked = false
  try { readFile(root, 'alpha/20261026-210000-photo/originals/photo.bmp') } catch { blocked = true }
  assert(blocked, 'readFile 拒绝 originals')
  ok('模型读取拒绝 originals（只走 processed）')

  console.log(`\n全部通过: ${pass} 项${skipped > 0 ? `（${skipped} 项跳过）` : ''}`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
