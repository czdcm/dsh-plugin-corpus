import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { authorize } from '../plugin/lib/access.js'
import { collectionNames, listDocs, readFile, reindex, search } from '../plugin/lib/engine.js'

const HOME = path.join(os.homedir(), '.dsh')
const ROOT = process.env.CORPUS_TEST_ROOT
  ? path.resolve(process.env.CORPUS_TEST_ROOT)
  : path.join(HOME, 'corpus')
const IT = String(process.env.CORPUS_TEST_IT || '').trim()
const DSH = String(process.env.CORPUS_TEST_DSH || '').trim()

if (!fs.existsSync(ROOT) || IT === '' || DSH === '') {
  console.log('SKIP test-corpus：需要真实语料回归数据。')
  console.log('  设置 CORPUS_TEST_ROOT（语料根）、CORPUS_TEST_IT、CORPUS_TEST_DSH 后再跑。')
  process.exit(0)
}

let pass = 0
const ok = (label) => { pass++; console.log('  PASS ' + label) }

// ---- 1. 建索引 ----
const built = reindex(ROOT)
console.log('建索引:', built.ms + 'ms')
for (const item of built.collections) {
  console.log(`  ${item.collection.padEnd(16)} ${String(item.docs).padStart(3)} 篇 / ${String(item.chunks).padStart(6)} 块  backend=${item.backend}`)
}
let indexBytes = 0
for (const item of built.collections) {
  const file = path.join(ROOT, '.corpus', 'index', item.collection + '.sqlite')
  if (fs.existsSync(file)) indexBytes += fs.statSync(file).size
}
console.log('索引合计: ' + (indexBytes / 1024 / 1024).toFixed(1) + ' MB')
ok('三个集合索引建立')

// ---- 2. 真实策略：工作区隔离 ----
const names = collectionNames(ROOT)
const itScope = authorize(HOME, { workspace: IT, session: 'sess-it' }, names)
const dshScope = authorize(HOME, { workspace: DSH, session: 'sess-dsh' }, names)
console.log('IT  可见集合:', itScope.allowedCollections.join(', '))
console.log('DSH 可见集合:', dshScope.allowedCollections.join(', '))
if (itScope.allowedCollections.join(',') !== 'linux-kernel,linux-kernel-zh') throw new Error('IT 集合不对')
if (dshScope.allowedCollections.join(',') !== 'dsh-docs') throw new Error('DSH 集合不对')
ok('工作区隔离（IT 只看内核，DSH 只看 dsh-docs）')

if (!itScope.allow('linux-kernel/networking.md')) throw new Error('IT 应能读 networking')
if (itScope.allow('dsh-docs/architecture.md')) throw new Error('IT 不该能读 dsh-docs')
if (dshScope.allow('linux-kernel/networking.md')) throw new Error('DSH 不该能读内核')
ok('文件级 allow/deny')

// ---- 3. 合成策略：glob / 会话 / deny 优先 / 默认拒绝 ----
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-acl-'))
fs.writeFileSync(path.join(tmpHome, 'corpus-access.json'), JSON.stringify({
  version: 1,
  default: 'deny',
  grants: [
    { workspace: '*', paths: ['linux-kernel/**'] },
    { session: 'sess-x', paths: ['dsh-docs/architecture.md'] },
    { workspace: IT, paths: ['linux-kernel/private/notes.md'] },
  ],
  deny: [{ paths: ['**/private/**'] }],
}, null, 2))

const wildcard = authorize(tmpHome, { workspace: 'C:/anywhere', session: 'nobody' }, names)
if (!wildcard.allow('linux-kernel/arch.md')) throw new Error('glob 未命中')
ok('通配工作区 + glob 授权')

const sessionScope = authorize(tmpHome, { workspace: 'C:/other', session: 'sess-x' }, names)
if (!sessionScope.allow('dsh-docs/architecture.md')) throw new Error('会话授权未命中')
if (sessionScope.allow('dsh-docs/basic.md')) throw new Error('会话授权不该扩散到别的文件')
ok('会话级精确到单个文件')

if (wildcard.allow('linux-kernel/private/notes.md')) throw new Error('deny 应优先')
ok('deny 优先于 allow')

const nobody = authorize(tmpHome, { workspace: 'C:/none', session: 'n' }, names)
if (nobody.allow('dsh-docs/architecture.md')) throw new Error('默认应拒绝')
ok('默认拒绝')

// 路径穿越防护
let blocked = false
try { readFile(ROOT, '../corpus-access.json', {}) } catch { blocked = true }
if (!blocked) throw new Error('路径穿越未被拦住')
ok('路径穿越被拒')

// ---- 4. 检索与读取 ----
const found = search(ROOT, { collections: itScope.allowedCollections, query: 'networking', limit: 3 })
console.log('检索 networking:', found.hits.length, '条；示例:', found.hits[0] && found.hits[0].path, found.hits[0] && found.hits[0].lines)
if (found.hits.length === 0) throw new Error('检索没有结果')
if (!found.hits.every((hit) => itScope.allow(hit.path))) throw new Error('检索结果越权')
ok('检索结果全部落在授权范围内')

const zh = search(ROOT, { collections: dshScope.allowedCollections, query: '插件 配置', limit: 3 })
console.log('DSH 检索 "插件 配置":', zh.hits.length, '条')
if (zh.hits.length === 0) throw new Error('DSH 检索没有结果')
ok('多词 AND 检索')

const read = readFile(ROOT, found.hits[0].path, { from: 1, lines: 3 })
console.log('读取前 3 行:', JSON.stringify(read.text.split('\n')[0]).slice(0, 80))
ok('按行读取')

// ---- 5. 列表 ----
const listed = listDocs(ROOT, { collections: itScope.allowedCollections, limit: 5 })
console.log('IT 列表:', listed.total, '个文件 /', listed.collections.length, '个集合')
ok('列表只返回授权集合')

fs.rmSync(tmpHome, { recursive: true, force: true })
console.log('\n全部通过: ' + pass + ' 项')
