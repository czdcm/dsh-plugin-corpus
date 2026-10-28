// dsh-plugin-corpus v1.7 — 删除语料（软删除）验收（自包含）。
//
// 覆盖：deleteDocument（v1.3 导入文件夹连原件一起移入 trash、旧平铺文件只移文件）、
// deleteCollection（集合目录 + 索引移入 trash）、POST /delete 路由返回 reindexJobId。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { deleteDocument, deleteCollection } from '../plugin/lib/trash.js'
import { createPanelRoutes } from '../plugin/lib/panel.js'

let pass = 0
const ok = (label) => { pass++; console.log('  PASS ' + label) }
const assert = (condition, message) => { if (!condition) throw new Error('ASSERT: ' + message) }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-trash-'))
const root = path.join(tmp, 'corpus')
const home = path.join(tmp, 'home')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(path.join(root, 'alpha'), { recursive: true })
fs.mkdirSync(path.join(root, 'beta'), { recursive: true })
const folder = path.join(root, 'alpha', '20261026-delete')
fs.mkdirSync(path.join(folder, 'originals'), { recursive: true })
fs.mkdirSync(path.join(folder, 'processed'), { recursive: true })
fs.writeFileSync(path.join(folder, 'originals', 'original.png'), 'original-bytes')
fs.writeFileSync(path.join(folder, 'processed', 'doc.md'), '# Doc\n')
fs.writeFileSync(path.join(folder, '.meta.json'), JSON.stringify({ original: 'alpha/20261026-delete/originals/original.png', processed: 'alpha/20261026-delete/processed/doc.md' }))
fs.writeFileSync(path.join(root, 'alpha', 'legacy.md'), '# Legacy\n')
fs.writeFileSync(path.join(root, 'alpha', 'keep.md'), '# Keep\n')
fs.writeFileSync(path.join(root, 'beta', 'other.md'), '# Other\n')
fs.mkdirSync(path.join(root, '.corpus', 'index'), { recursive: true })
fs.writeFileSync(path.join(root, '.corpus', 'index', 'beta.sqlite'), 'index')
fs.writeFileSync(path.join(root, '.corpus', 'index', 'beta-zh.sqlite'), 'index-zh')

try {
  const doc = deleteDocument(root, 'alpha/20261026-delete/processed/doc.md')
  assert(doc.kind === 'import-folder' && doc.collection === 'alpha', 'deleteDocument 整个导入文件夹: ' + JSON.stringify(doc))
  assert(!fs.existsSync(folder), '导入文件夹已移走')
  assert(fs.existsSync(path.join(root, 'alpha', 'keep.md')), '同集合其他文件未受影响')
  const trashed = path.join(root, ...doc.trashed.split('/'))
  assert(fs.existsSync(path.join(trashed, 'originals', 'original.png')), '原件随导入文件夹进入 trash')
  assert(fs.existsSync(path.join(trashed, 'processed', 'doc.md')), 'processed 进入 trash')
  ok('deleteDocument：导入文件夹连原件整体软删除')

  const legacy = deleteDocument(root, 'alpha/legacy.md')
  assert(legacy.kind === 'file' && !fs.existsSync(path.join(root, 'alpha', 'legacy.md')), '旧平铺文件删除')
  assert(fs.existsSync(path.join(root, ...legacy.trashed.split('/'))), '旧文件进入 trash')
  ok('deleteDocument：旧平铺文件只移该文件')

  const removed = deleteCollection(root, 'beta')
  assert(removed.kind === 'collection' && !fs.existsSync(path.join(root, 'beta')), '集合删除')
  assert(fs.existsSync(path.join(root, 'alpha')), '其他集合保留')
  assert(!fs.existsSync(path.join(root, '.corpus', 'index', 'beta.sqlite')), '集合索引被清理')
  assert(fs.existsSync(path.join(root, '.corpus', 'index', 'beta-zh.sqlite')), '同前缀其他集合的索引不受影响')
  assert(fs.existsSync(path.join(root, ...removed.trashed.split('/'), 'other.md')), '集合内容进入 trash/collections')
  ok('deleteCollection：集合 + 索引清理 + trash/collections')

  // 面板 POST /delete：路径删除 + 触发集合重建
  const reindex = []
  const routes = createPanelRoutes({
    root,
    dshHome: home,
    jobs: { start: (options) => { reindex.push(options); return { started: true, job: { id: 'reindex-del' } } }, status: () => ({ active: null, recent: [] }) },
    sessionLookup: () => null,
    ingest: { status: () => ({ active: null, recent: [] }), limits: { maxFiles: 200, maxUploadBytes: 1024 } },
  })
  assert(routes.length === 18, '面板路由 17 条，实际 ' + routes.length)
  const route = routes.find((item) => item.path === '/api/dsh-plugin-corpus/delete')
  assert(route !== undefined, '存在 /delete 路由')
  const body = JSON.stringify({ path: 'alpha/legacy.md' })
  // 重新放一个 legacy 文件，供路由删除。
  fs.writeFileSync(path.join(root, 'alpha', 'legacy.md'), '# Legacy again\n')
  const result = await new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(body)])
    req.method = 'POST'
    req.url = '/api/dsh-plugin-corpus/delete'
    req.headers = { host: '127.0.0.1:1', 'content-type': 'application/json' }
    const res = { statusCode: 0, setHeader() {}, end(value) { resolve({ status: this.statusCode, text: String(value || '') }) } }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
  const payload = JSON.parse(result.text)
  assert(result.status === 200 && payload.ok === true && payload.reindexJobId === 'reindex-del', 'POST /delete 删除并重建: ' + result.text)
  assert(reindex.length === 1 && reindex[0].names[0] === 'alpha', '删除文档触发集合重建')
  ok('POST /delete：软删除 + 自动重建')

  console.log('\n全部通过: ' + pass + ' 项（v1.7 删除语料）')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
