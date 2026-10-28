// dsh-plugin-corpus v1.5 — 语料库根目录设置/迁移验收（自包含）。
//
// 覆盖：expandRoot（默认/state 优先）、migrateRoot（move+junction 或 copy 回退）、
// 全部数据（集合、.corpus/index、config）一起搬、旧运行路径仍可读（junction 时）、
// /settings API 返回新根目录与 stateFile。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { migrateRoot, readRootState, expandRoot, rootStatePath } from '../plugin/lib/settings.js'
import { createPanelRoutes } from '../plugin/lib/panel.js'

let pass = 0
const ok = (label) => { pass++; console.log('  PASS ' + label) }
const assert = (condition, message) => { if (!condition) throw new Error('ASSERT: ' + message) }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-settings-'))
const dshHome = path.join(tmp, 'dsh')
fs.mkdirSync(dshHome, { recursive: true })
const root1 = path.join(tmp, 'corpus-old')
const root2 = path.join(tmp, 'corpus-new')
fs.mkdirSync(path.join(root1, 'alpha', 'demo', 'processed'), { recursive: true })
fs.mkdirSync(path.join(root1, '.corpus', 'index'), { recursive: true })
fs.writeFileSync(path.join(root1, 'alpha', 'demo', 'processed', 'one.md'), '# one\n')
fs.writeFileSync(path.join(root1, '.corpus', 'index', 'alpha.sqlite'), 'fake-index')
fs.writeFileSync(path.join(root1, '.corpus', 'config.json'), '{"alpha":{"backend":"like"}}')

try {
  assert(expandRoot('', dshHome) === path.join(dshHome, 'corpus'), '默认根目录')
  const moved = migrateRoot({ dshHome, currentRoot: root1, newRoot: root2 })
  assert(moved.ok === true && moved.root === root2, '迁移返回新根目录: ' + JSON.stringify(moved))
  assert(moved.mode === 'junction' || moved.mode === 'copy', '迁移模式: ' + moved.mode)
  assert(fs.existsSync(path.join(root2, 'alpha', 'demo', 'processed', 'one.md')), '新根目录有 processed')
  assert(fs.existsSync(path.join(root2, '.corpus', 'index', 'alpha.sqlite')), '新根目录有索引')
  assert(fs.existsSync(path.join(root2, '.corpus', 'config.json')), '新根目录有集合 config')
  ok('migrateRoot：整个语料根（集合 + 索引 + config）搬到新路径')

  const state = readRootState(dshHome)
  assert(state !== null && state.root === root2, 'corpus-root.json 记录新根')
  assert(fs.existsSync(rootStatePath(dshHome)), 'stateFile 存在')
  assert(expandRoot('', dshHome) === root2, 'expandRoot 优先使用 state')
  ok('state 文件与 expandRoot 优先级')

  if (moved.mode === 'junction') {
    assert(fs.readFileSync(path.join(root1, 'alpha', 'demo', 'processed', 'one.md'), 'utf8') === '# one\n', '旧运行路径通过 junction 仍可读')
    assert(fs.lstatSync(root1).isSymbolicLink(), '旧运行路径是目录联接')
    ok('junction 模式：当前进程旧路径继续可读写')
  } else {
    assert(moved.restartRequired === true, 'copy 模式要求重启')
    ok('copy 模式：返回 restartRequired（旧目录保留）')
  }

  // 面板 GET /settings 用 state 中的新根目录显示，且 API 形状可被前端消费。
  const routes = createPanelRoutes({ root: root1, dshHome, jobs: { status: () => ({ active: null, recent: [] }) }, sessionLookup: () => null, ingest: { status: () => ({ active: null, recent: [] }), limits: { maxFiles: 200, maxUploadBytes: 1024 } } })
  assert(routes.length === 18, '面板路由 17 条，实际 ' + routes.length)
  const route = routes.find((item) => item.path === '/api/dsh-plugin-corpus/settings')
  assert(route !== undefined, '存在 /settings 路由')
  const result = await new Promise((resolve, reject) => {
    const req = Readable.from([])
    req.method = 'GET'
    req.url = '/api/dsh-plugin-corpus/settings'
    req.headers = { host: '127.0.0.1:1' }
    let text = ''
    const res = { statusCode: 0, setHeader() {}, end(value) { resolve({ status: this.statusCode, text: String(value || '') }) } }
    Promise.resolve(route.handler(req, res)).catch(reject)
    void text
  })
  const body = JSON.parse(result.text)
  assert(result.status === 200 && body.ok === true && body.root === root2, 'GET /settings 返回新根目录: ' + result.text)
  assert(body.stateFile === rootStatePath(dshHome) && body.runtimeRoot === root1, '/settings 返回 stateFile 与 runtimeRoot')
  ok('GET /settings：显示迁移后的根目录/设置文件/运行路径')

  console.log('\n全部通过: ' + pass + ' 项（v1.5 语料库根目录设置）')
} finally {
  for (const candidate of [root1, root2]) {
    try { if (fs.lstatSync(candidate).isSymbolicLink()) fs.rmdirSync(candidate) } catch { /* ignore */ }
  }
  fs.rmSync(tmp, { recursive: true, force: true })
}
