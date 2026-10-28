/**
 * dsh-plugin-corpus v1.1 验收测试。
 *
 * 自包含：只在 os.tmpdir() 下造合成语料，不依赖也不读写 ~/.dsh/corpus；
 * 结束（含失败）时清理临时目录。
 *
 * 覆盖：
 *   · engine.importInto —— 目录/单文件导入、prefix、extensions、二进制/超限/隐藏/镜像目录
 *     跳过、集合名校验、目标路径不越界、move、导入后可检索；
 *   · readFile 加固 —— `..` 穿越、绝对路径、.corpus 元目录、未知集合、扩展名白名单、
 *     含 NUL 的二进制、符号链接/junction；
 *   · collectionStatus / stats —— 字段与数值（like、ripgrep、未建索引三种状态）；
 *   · jobs.createJobRunner —— 启动、单任务串行、wait 到 done、result、锁释放、
 *     陈旧锁（死 pid / 超过 2 小时）回收、活锁拒绝、dispose；
 *   · panel.createPanelRoutes —— 用假 req/res 驱动，18 条路由：/overview、/files、/search
 *    （普通 + workspace ACL 过滤）、/read、/reindex → /status、/policy、
 *    /access、/import/targets、POST /import、/import/status、/
 *    v1.5 的 GET /settings（形状/busy）、POST /settings/root（任务运行中 409、目标嵌套 400），
 *    同源 403、方法 405、未知集合 404、坏请求 400、无 ingest 服务时的降级。
 *
 * 运行（DSH 自带 Node 24）：
 *   & "…\dependencies\node\bin\node.exe" tests\test-corpus-v2.mjs
 * 输出：PASS 行 + 末尾「全部通过: N 项」；失败抛错、退出码非 0。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { normalize } from '../plugin/lib/access.js'
import { SUPPORTED_EXTENSIONS } from '../plugin/lib/extract.js'
import {
  collectionNames,
  collectionStatus,
  configPath,
  importInto,
  readFile,
  reindex,
  scanCollection,
  search,
  stats,
} from '../plugin/lib/engine.js'
import { createJobRunner } from '../plugin/lib/jobs.js'
import { acquireLock, lockPath, readLock } from '../plugin/lib/lock.js'
import { createPanelRoutes, PANEL_PREFIX } from '../plugin/lib/panel.js'
import { isValidCollectionName } from '../plugin/lib/collection-name.js'

let pass = 0
let skip = 0
const ok = (label) => { pass++; console.log('  PASS ' + label) }
const skipTest = (label, reason) => { skip++; console.log('  SKIP ' + label + '（' + reason + '）') }
const assert = (condition, message) => { if (!condition) throw new Error('ASSERT: ' + message) }

function expectThrows(fn, label, needle) {
  let error = null
  try { fn() } catch (caught) { error = caught }
  if (error === null) throw new Error(`应当被拒绝却成功了：${label}`)
  if (needle && !String(error && error.message).includes(needle)) {
    throw new Error(`拒绝原因不符（${label}）：期望包含「${needle}」，实际「${error && error.message}」`)
  }
  return error
}

async function expectRejects(value, label) {
  try { await value } catch { return }
  throw new Error(`应当被拒绝却成功了：${label}`)
}

// ---------------------------------------------------------------------------
// 临时环境（语料根 / 策略目录 / 语料根外的目录）
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-v2-'))
const root = path.join(tmp, 'corpus')
const home = path.join(tmp, 'home')
const outside = path.join(tmp, 'outside')
const runners = []

fs.mkdirSync(root, { recursive: true })
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(outside, { recursive: true })
fs.writeFileSync(path.join(outside, 'secret.md'), '# Outside\n\nmust not be readable through the corpus root\n')

try {
  // -------------------------------------------------------------------------
  // 0. 合成集合 + 配置 + 初始重建
  // -------------------------------------------------------------------------
  fs.mkdirSync(path.join(root, 'alpha'), { recursive: true })
  const alphaA = '# Alpha A\n\nhello corpus world\nsecond line\n'
  const alphaB = '# Alpha B\n\nanother document\n'
  fs.writeFileSync(path.join(root, 'alpha', 'a.md'), alphaA)
  fs.writeFileSync(path.join(root, 'alpha', 'b.md'), alphaB)

  fs.mkdirSync(path.join(root, 'code'), { recursive: true })
  const codeMain = 'int main(void) { return 0; }\n'
  fs.writeFileSync(path.join(root, 'code', 'main.c'), codeMain)

  fs.mkdirSync(path.dirname(configPath(root)), { recursive: true })
  fs.writeFileSync(configPath(root), JSON.stringify({
    version: 1,
    defaults: { extensions: ['.md', '.txt'] },
    collections: {
      code: { backend: 'ripgrep', extensions: ['.c'] },
      imported: { maxFileBytes: 1000 },
    },
  }, null, 2))

  const built = reindex(root)
  const alphaReport = built.collections.find((item) => item.collection === 'alpha')
  const codeReport = built.collections.find((item) => item.collection === 'code')
  assert(built.ok === true && built.collections.length === 2, '初始重建应覆盖 alpha/code 两个集合')
  assert(alphaReport && alphaReport.backend === 'like' && alphaReport.docs === 2 && alphaReport.added === 2, 'alpha 应建 2 篇')
  assert(codeReport && codeReport.backend === 'ripgrep' && codeReport.docs === 0 && /rg|ripgrep/i.test(String(codeReport.note)), 'ripgrep 集合不建索引')
  ok('初始重建：like 建索引、ripgrep 集合跳过')

  // -------------------------------------------------------------------------
  // 1. collectionStatus / stats
  // -------------------------------------------------------------------------
  const status0 = collectionStatus(root)
  const alphaStatus = status0.find((item) => item.name === 'alpha')
  const codeStatus = status0.find((item) => item.name === 'code')
  assert(status0.length === 2, 'collectionStatus 应有 2 个集合')
  for (const key of ['name', 'backend', 'docs', 'chunks', 'bytes', 'indexedAt', 'indexBytes']) {
    assert(Object.prototype.hasOwnProperty.call(alphaStatus, key), 'collectionStatus 缺字段 ' + key)
  }
  const alphaBytes = Buffer.byteLength(alphaA) + Buffer.byteLength(alphaB)
  assert(alphaStatus.backend === 'like' && alphaStatus.docs === 2 && alphaStatus.chunks === 2, 'alpha 状态 2 篇 / 2 块')
  assert(alphaStatus.bytes === alphaBytes, 'alpha 字节数应等于两个文件大小之和')
  assert(typeof alphaStatus.indexedAt === 'string' && !Number.isNaN(Date.parse(alphaStatus.indexedAt)), 'indexedAt 应为 ISO 时间')
  assert(alphaStatus.indexBytes > 0, 'alpha indexBytes 应大于 0')
  assert(codeStatus.backend === 'ripgrep' && codeStatus.docs === 1 && codeStatus.chunks === 0, 'ripgrep 集合按文件计数、无块')
  assert(codeStatus.bytes === Buffer.byteLength(codeMain) && codeStatus.indexedAt === null && codeStatus.indexBytes === 0, 'ripgrep 集合无索引')
  ok('collectionStatus：like / ripgrep 字段与数值')

  const stats0 = stats(root)
  assert(stats0.collections === 2 && stats0.docs === 3 && stats0.chunks === 2, 'stats 集合 2 / 文档 3 / 块 2')
  assert(stats0.bytes === alphaBytes + Buffer.byteLength(codeMain), 'stats 字节数汇总')
  assert(stats0.indexBytes === alphaStatus.indexBytes + codeStatus.indexBytes, 'stats 索引体积汇总')
  ok('stats：集合数 / 文档数 / 块数 / 字节 / 索引体积')

  // -------------------------------------------------------------------------
  // 2. importInto
  // -------------------------------------------------------------------------
  const src = path.join(tmp, 'src')
  fs.mkdirSync(path.join(src, 'sub'), { recursive: true })
  fs.mkdirSync(path.join(src, '.git'), { recursive: true })
  fs.mkdirSync(path.join(src, 'node_modules', 'pkg'), { recursive: true })
  const notes = '# Notes\n\ndeep corpus import\n'
  const deep = '# Deep\n\nnested import content\n'
  fs.writeFileSync(path.join(src, 'notes.md'), notes)
  fs.writeFileSync(path.join(src, 'sub', 'deep.md'), deep)
  fs.writeFileSync(path.join(src, 'bin.md'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]))
  fs.writeFileSync(path.join(src, 'big.md'), '# Big\n\n' + 'x'.repeat(2000))
  fs.writeFileSync(path.join(src, 'skip.png'), Buffer.from('not a text corpus file'))
  fs.writeFileSync(path.join(src, '.hidden.md'), '# Hidden\n\nhidden\n')
  fs.writeFileSync(path.join(src, '.git', 'ignored.md'), '# Ignored\n')
  fs.writeFileSync(path.join(src, 'node_modules', 'pkg', 'ignored.md'), '# Ignored\n')

  // Windows 上文件符号链接通常要开发者模式；目录 junction 一般可用。两者都试一次。
  const symlink = { file: false, junction: false }
  try {
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'alpha', 'link.md'))
    symlink.file = true
  } catch { /* 无权限，跳过文件符号链接 */ }
  try {
    fs.symlinkSync(outside, path.join(root, 'alpha', 'linkdir.md'), 'junction')
    symlink.junction = true
  } catch { /* 无权限，跳过 junction */ }
  // 源目录里的 junction 应被导入跳过（若本机可用）
  let srcJunction = false
  if (symlink.junction) {
    try { fs.symlinkSync(outside, path.join(src, 'junction-in.md'), 'junction'); srcJunction = true } catch { /* ignore */ }
  }

  const importedDir = importInto(root, { source: src, collection: 'imported', prefix: 'inbox' })
  assert(importedDir.ok === true && importedDir.collection === 'imported', 'importInto 应成功且 collection=imported')
  assert(importedDir.source === path.resolve(src), 'source 应解析成绝对路径')
  assert(importedDir.imported === 2, '目录导入应只导入 2 个文本文件，实际 ' + importedDir.imported)
  assert(importedDir.skipped === 3, '应跳过二进制/超限/非白名单扩展共 3 个，实际 ' + importedDir.skipped)
  assert(importedDir.files.includes('imported/inbox/notes.md'), 'files 应含 imported/inbox/notes.md')
  assert(importedDir.files.includes('imported/inbox/sub/deep.md'), 'files 应保留子目录层级')
  assert(importedDir.bytes === Buffer.byteLength(notes) + Buffer.byteLength(deep), 'imported.bytes 应等于两个文件大小之和')
  assert(importedDir.fileCount === 2 && importedDir.filesTruncated === false, 'fileCount 应为 2，files 未截断')
  assert(importedDir.truncated === false, '未达 maxFiles，不应 truncated')
  assert(importedDir.notes.some((note) => note.includes('跳过二进制')), 'notes 应记录二进制跳过')
  assert(importedDir.notes.some((note) => note.includes('跳过超限')), 'notes 应记录超限跳过')
  assert(fs.readFileSync(path.join(root, 'imported', 'inbox', 'sub', 'deep.md'), 'utf8') === deep, '导入后磁盘内容应一致')
  assert(!fs.existsSync(path.join(root, 'imported', 'inbox', '.hidden.md')), '隐藏文件不应被导入')
  assert(!fs.existsSync(path.join(root, 'imported', 'inbox', '.git')), '.git 不应被导入')
  assert(!fs.existsSync(path.join(root, 'imported', 'inbox', 'node_modules')), 'node_modules 不应被导入')
  if (srcJunction) assert(!fs.existsSync(path.join(root, 'imported', 'inbox', 'junction-in.md')), '源目录里的 junction 不应被导入')
  ok('目录导入：prefix / 层级 / 跳过二进制·超限·隐藏·镜像目录' + (srcJunction ? '·junction' : ''))

  const preStatus = collectionStatus(root).find((item) => item.name === 'imported')
  assert(preStatus.docs === 0 && preStatus.chunks === 0 && preStatus.bytes === 0, '刚导入未建索引时 docs/chunks/bytes 应为 0')
  assert(preStatus.indexedAt === null && preStatus.indexBytes === 0, '刚导入未建索引时不应有索引时间与体积')
  ok('未建索引的集合显示为 0 / 未索引')

  const one = path.join(tmp, 'one.txt')
  fs.writeFileSync(one, 'single file import target\n')
  const importedOne = importInto(root, { source: one, collection: 'imported', prefix: 'solo' })
  assert(importedOne.imported === 1 && importedOne.files[0] === 'imported/solo/one.txt', '单文件导入应进 prefix 子目录')
  assert(fs.readFileSync(path.join(root, 'imported', 'solo', 'one.txt'), 'utf8').includes('single file'), '单文件内容应落盘')
  ok('单文件导入 + 子目录前缀')

  const extsrc = path.join(tmp, 'extsrc')
  fs.mkdirSync(extsrc, { recursive: true })
  fs.writeFileSync(path.join(extsrc, 'keep.md'), '# Keep\n\nkeep me\n')
  fs.writeFileSync(path.join(extsrc, 'drop.txt'), 'drop me\n')
  const importedExt = importInto(root, { source: extsrc, collection: 'imported', prefix: 'ext', extensions: ['md'] })
  assert(importedExt.imported === 1 && importedExt.files[0] === 'imported/ext/keep.md', 'extensions 过滤后应只导入 keep.md')
  assert(!fs.existsSync(path.join(root, 'imported', 'ext', 'drop.txt')), 'drop.txt 不应被导入')
  ok('extensions 过滤（支持不带点的写法）')

  const movable = path.join(tmp, 'movable', 'moved.md')
  fs.mkdirSync(path.dirname(movable), { recursive: true })
  fs.writeFileSync(movable, '# Moved\n\nmoved file\n')
  const importedMove = importInto(root, { source: movable, collection: 'imported', prefix: 'moved', move: true })
  assert(importedMove.imported === 1 && importedMove.files[0] === 'imported/moved/moved.md', 'move 导入应复制到目标')
  assert(!fs.existsSync(movable), 'move=true 应删除源文件')
  assert(fs.existsSync(path.join(root, 'imported', 'moved', 'moved.md')), 'move 导入的目标文件应存在')
  ok('move 语义：复制成功后再删除源文件')

  for (const bad of ['', '..', '.hidden', 'bad/name', 'a/b', 'x'.repeat(65)]) {
    expectThrows(
      () => importInto(root, { source: one, collection: bad }),
      '非法集合名 ' + JSON.stringify(bad.length > 20 ? bad.slice(0, 8) + '…' : bad),
    )
  }
  ok('集合名校验：空 / 点开头 / 斜杠 / 超长')

  const localizedCollection = '结构力学 教材（第一册）'
  const localizedRoot = path.join(tmp, 'localized-corpus')
  fs.mkdirSync(localizedRoot, { recursive: true })
  importInto(localizedRoot, { source: one, collection: localizedCollection })
  assert(fs.existsSync(path.join(localizedRoot, localizedCollection, path.basename(one))), '中文/空格/全角括号集合名应能导入')
  ok('集合名支持中文、空格与常用符号：' + localizedCollection)

  for (const bad of ['..', 'a/../b', 'a//b']) {
    expectThrows(() => importInto(root, { source: one, collection: 'imported', prefix: bad }), '非法 prefix ' + JSON.stringify(bad))
  }
  ok('prefix 拒绝 .. 与空路径段')

  const driveRoot = path.parse(tmp).root
  const escapePrefix = driveRoot.replace(/\\/g, '/') + 'dsh-corpus-escape-' + Math.random().toString(36).slice(2, 10)
  const escapedTarget = path.resolve(escapePrefix + '/one.txt')
  const escapeResult = importInto(root, { source: one, collection: 'imported', prefix: escapePrefix })
  assert(escapeResult.imported === 0 && escapeResult.files.length === 0, '绝对 prefix 不应导入任何文件')
  assert(!fs.existsSync(escapedTarget), '绝对 prefix 不应把文件写到集合目录之外：' + escapedTarget)
  ok('目标路径不越界：绝对 prefix 被丢弃')

  expectThrows(() => importInto(root, { source: path.join(tmp, 'does-not-exist.md'), collection: 'imported' }), '不存在的源路径', '找不到源路径')
  if (symlink.file || symlink.junction) {
    const linkSource = symlink.file ? path.join(root, 'alpha', 'link.md') : path.join(root, 'alpha', 'linkdir.md')
    expectThrows(() => importInto(root, { source: linkSource, collection: 'imported' }), '符号链接源路径', '不允许导入符号链接')
    ok('源路径是符号链接时拒绝导入')
  } else {
    skipTest('源路径是符号链接时拒绝导入', '本机无法创建符号链接/junction')
  }

  // -------------------------------------------------------------------------
  // 3. 读取加固
  // -------------------------------------------------------------------------
  const readOk = readFile(root, 'imported/inbox/notes.md', { from: 1, lines: 2 })
  assert(readOk.ok === true && readOk.path === 'imported/inbox/notes.md', '按行读取应成功')
  assert(readOk.totalLines === 4 && readOk.from === 1 && readOk.to === 2 && readOk.truncated === true, '分页信息应为 1-2/4 且 truncated')
  assert(readOk.text.split('\n')[0] === '     1| # Notes', '首行应带 6 位列号，实际：' + JSON.stringify(readOk.text.split('\n')[0]))
  ok('按行读取：行号 / from-to / totalLines / truncated')

  for (const bad of ['../corpus-access.json', 'imported/../../outside/secret.md', path.join(root, 'alpha', 'a.md')]) {
    expectThrows(() => readFile(root, bad), '越界路径 ' + bad)
  }
  ok('读取拒绝 .. 穿越与绝对路径')

  expectThrows(() => readFile(root, '.corpus/config.json'), '.corpus 元目录')
  expectThrows(() => readFile(root, '.corpus/index/alpha.sqlite'), '.corpus 索引')
  ok('.corpus 元目录不可读')

  expectThrows(() => readFile(root, 'missing/x.md'), '未知集合', '不在已知集合内')
  ok('未知集合不可读')

  fs.writeFileSync(path.join(root, 'imported', 'data.dat'), 'plain text but not allowed\n')
  expectThrows(() => readFile(root, 'imported/data.dat'), '扩展名不在白名单', '不是可读取的语料文件')
  ok('扩展名不在白名单不可读')

  fs.writeFileSync(path.join(root, 'imported', 'binary.md'), Buffer.from('# Binary\n\n\u0000\u0001\u0002\n'))
  expectThrows(() => readFile(root, 'imported/binary.md'), '含 NUL 的二进制', '不是文本文件')
  ok('含 NUL 的二进制文本不可读')

  if (symlink.file || symlink.junction) {
    if (symlink.file) {
      expectThrows(() => readFile(root, 'alpha/link.md'), '文件符号链接', '不允许读取符号链接')
    }
    if (symlink.junction) {
      expectThrows(() => readFile(root, 'alpha/linkdir.md'), 'junction 本身', '不允许读取符号链接')
      expectThrows(() => readFile(root, 'alpha/linkdir.md/secret.md'), '经 junction 指向 root 外', '路径越界')
      assert(!scanCollection(root, 'alpha').includes('linkdir.md/secret.md'), 'scanCollection 不应跟随 junction')
    }
    ok('符号链接 / junction：读取、realpath 越界、集合扫描均被拒')
  } else {
    skipTest('符号链接 / junction 加固', '本机无法创建 symlink/junction（Windows 需要开发者模式或管理员权限）')
  }

  // -------------------------------------------------------------------------
  // 4. 导入后重建索引 + 检索
  // -------------------------------------------------------------------------
  const importedBuilt = reindex(root, { names: ['imported'] })
  const importedReport = importedBuilt.collections[0]
  assert(importedReport && importedReport.collection === 'imported', '重建 imported 集合')
  assert(importedReport.docs === 5, '导入集应有 5 篇（二进制与非白名单扩展不计入），实际 ' + importedReport.docs)
  assert(importedReport.chunks >= 5, '导入集应有至少 5 个块')
  ok('导入后重建：二进制 / 非白名单扩展不计入文档数')

  const nested = search(root, { collections: ['imported'], query: 'nested import', limit: 5 })
  assert(nested.ok === true && nested.hits.length > 0, '导入内容应可检索')
  assert(nested.hits[0].path === 'imported/inbox/sub/deep.md', '命中路径应为嵌套导入文件，实际 ' + nested.hits[0].path)
  const single = search(root, { collections: ['imported'], query: 'single file', limit: 5 })
  assert(single.hits.some((hit) => hit.path === 'imported/solo/one.txt'), '单文件导入内容应可检索')
  ok('导入内容可检索（命中路径与文件）')

  // -------------------------------------------------------------------------
  // 5. 异步重建任务 + 锁
  // -------------------------------------------------------------------------
  const runner = createJobRunner({ root })
  runners.push(runner)

  const started = runner.start({ names: ['alpha'] })
  assert(started.started === true && started.job, '应启动重建任务')
  const job = started.job
  assert(/^job-\d+-[a-z0-9]+$/.test(job.id), 'jobId 格式应为 job-<epoch>-<rand>，实际 ' + job.id)
  assert(job.state === 'running' && job.names.join(',') === 'alpha' && job.force === false, '任务快照字段')
  const second = runner.start({ names: ['imported'] })
  assert(second.started === false && second.job && second.job.id === job.id, '同一时刻只允许一个任务，应返回当前任务')
  assert(runner.status().active && runner.status().active.id === job.id, 'status.active 应是当前任务')
  ok('异步任务：启动 / 同一时刻只跑一个')

  const done = await runner.wait(job.id, 30000)
  assert(done.state === 'done', '任务应完成，实际 ' + done.state + '：' + (done.error || ''))
  assert(done.result && done.result.ok === true, '任务应带回 reindex 结果')
  assert(done.result.collections.some((item) => item.collection === 'alpha' && item.docs === 2), '结果应含 alpha 2 篇')
  assert(typeof done.finishedAt === 'number' && typeof done.ms === 'number' && done.error === null, '完成时间/耗时字段')
  assert(!fs.existsSync(lockPath(root)) && readLock(root) === null, '任务结束应释放锁文件')
  ok('wait 到 done：result / 耗时 / 锁释放')

  const after = runner.status()
  assert(after.active === null && after.recent.length >= 1, '任务结束后 active 应为空、recent 应有记录')
  assert(after.recent[0].id === job.id && after.recent[0].state === 'done' && after.recent[0].result.ok === true, 'recent 应记录已完成任务')
  ok('status 快照：active 清空、recent 保留结果')

  const forceStart = runner.start({ names: ['alpha'], force: true })
  assert(forceStart.started === true && forceStart.job.force === true, 'force 任务应启动')
  const forceDone = await runner.wait(forceStart.job.id, 30000)
  assert(forceDone.state === 'done' && forceDone.result.collections[0].updated === 2 && forceDone.result.collections[0].skipped === 0, 'force 应把 2 个文件全部重切')
  ok('force 全量重建：两个文件都重切（updated=2）')

  fs.mkdirSync(path.dirname(lockPath(root)), { recursive: true })
  fs.writeFileSync(lockPath(root), JSON.stringify({ pid: 999999, startedAt: Date.now(), token: 'dead', names: ['alpha'] }))
  const reclaimed = acquireLock(root, ['alpha'])
  assert(reclaimed.ok === true, '死 pid 的陈旧锁应可回收')
  reclaimed.release()
  assert(!fs.existsSync(lockPath(root)), '回收的锁应能释放')
  ok('陈旧锁（死 pid）回收')

  const held = acquireLock(root, [])
  assert(held.ok === true, '先取得一把锁')
  const heldAgain = acquireLock(root, [])
  assert(heldAgain.ok === false && heldAgain.locked && heldAgain.locked.pid === process.pid, '活锁应拒绝第二个写者并报告 pid')
  held.release()
  ok('活锁被占用时拒绝第二个写者')

  fs.writeFileSync(lockPath(root), JSON.stringify({ pid: process.pid, startedAt: Date.now() - 3 * 60 * 60 * 1000, token: 'old', names: [] }))
  const expired = acquireLock(root, [])
  assert(expired.ok === true, '超过 2 小时的锁应按过期回收')
  expired.release()
  ok('超过 2 小时的锁按过期回收')

  fs.writeFileSync(lockPath(root), JSON.stringify({ pid: 999999, startedAt: Date.now(), token: 'dead2', names: [] }))
  const reclaimedStart = runner.start({ names: ['alpha'] })
  assert(reclaimedStart.started === true, '任务启动时应回收陈旧锁')
  const reclaimedDone = await runner.wait(reclaimedStart.job.id, 30000)
  assert(reclaimedDone.state === 'done', '回收锁后的任务应完成')
  assert(!fs.existsSync(lockPath(root)), '回收锁后的任务结束也应释放锁')
  ok('任务启动时回收陈旧锁并正常释放')

  await expectRejects(runner.wait('job-does-not-exist', 500), '等待未知任务')
  ok('等待未知任务被拒绝')

  runner.dispose()
  expectThrows(() => runner.start({ names: ['alpha'] }), 'dispose 后启动', '已关闭')
  ok('dispose 后拒绝新任务')

  // -------------------------------------------------------------------------
  // 6. 面板 HTTP API（假 req/res）
  // -------------------------------------------------------------------------
  fs.writeFileSync(path.join(home, 'corpus-access.json'), JSON.stringify({
    version: 1,
    default: 'deny',
    grants: [
      { workspace: 'C:/X', paths: ['alpha'] },
      { workspace: 'C:/Y', paths: ['imported'] },
    ],
    deny: [{ paths: ['**/private/**'] }],
  }, null, 2))

  const panelJobs = createJobRunner({ root })
  runners.push(panelJobs)
  const sessionLookup = (id) => (id === 'session-v2' ? { id, workspace: 'C:/X' } : null)
  // v1.3：导入服务用 fake，避免测试里真的跑模型/写文件；只验证路由的映射与状态码。
  const fakeIngest = {
    startCalls: [],
    start(options) {
      fakeIngest.startCalls.push(options)
      if (options.collection === 'busy-collection') {
        return { started: false, job: { id: 'ingest-busy-1', state: 'running' } }
      }
      if (!isValidCollectionName(options.collection || '')) {
        throw new Error('集合名不合法')
      }
      return { started: true, job: { id: 'ingest-fake-1', state: 'running', collection: options.collection, total: 0 } }
    },
    status() {
      return {
        active: { id: 'ingest-fake-1', state: 'running', current: { source: 'demo.md', stage: 'extract', index: 1, total: 1 } },
        recent: [{ id: 'ingest-done-0', state: 'done', done: 2, failed: 0 }],
      }
    },
    aiAvailable: () => true,
    visionAvailable: async () => true,
    limits: { maxFiles: 200, maxUploadBytes: 25 * 1024 * 1024 },
  }
  const routes = createPanelRoutes({ root, dshHome: home, jobs: panelJobs, sessionLookup, ingest: fakeIngest })
  const byPath = new Map(routes.map((route) => [route.path, route]))

  assert(routes.length === 18, '面板应有 18 条路由，实际 ' + routes.length)
  assert(routes.every((route) => route.kind === 'exact' && route.path.startsWith(PANEL_PREFIX)), '路由应为 exact 且带统一前缀')
  for (const suffix of ['overview', 'files', 'search', 'read', 'reindex', 'status', 'policy', 'access', 'import/targets', 'import', 'import/status', 'app-icon', 'settings', 'settings/root', 'settings/open', 'gallery', 'delete']) {
    assert(byPath.has(PANEL_PREFIX + '/' + suffix), '缺少路由 ' + suffix)
  }
  ok('面板路由表：18 条 exact（v1.2 /access + v1.3 /import/*），前缀 ' + PANEL_PREFIX)

  const invokeRoutes = (routeList, method, url, body, headers = {}) => new Promise((resolve, reject) => {
    const route = routeList.find((item) => item.path === url.split('?')[0])
    if (!route) return reject(new Error('没有路由 ' + url))
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = Readable.from(chunks)
    req.method = method
    req.url = url
    req.headers = { host: '127.0.0.1:1234', ...headers }
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) { this.headers[name] = value },
      end(text) {
        let parsed = null
        try { parsed = text ? JSON.parse(text) : null } catch (error) { reject(error); return }
        resolve({ status: this.statusCode, body: parsed })
      },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
  const invoke = (method, url, body, headers) => invokeRoutes(routes, method, url, body, headers)

  // 二进制路由（/original、/thumbnail 用 fs.createReadStream().pipe(res) 或 res.end(buffer)）：
  // 用 Writable 捕获响应体；JSON 错误响应也能从 body 里 JSON.parse 出来。
  const invokeBinaryRoutes = (routeList, method, url) => new Promise((resolve, reject) => {
    const route = routeList.find((item) => item.path === url.split('?')[0])
    if (!route) return reject(new Error('没有路由 ' + url))
    const req = Readable.from([])
    req.method = method
    req.url = url
    req.headers = { host: '127.0.0.1:1234' }
    const chunks = []
    const res = new Writable({
      write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback() },
    })
    res.statusCode = 0
    res.headers = {}
    res.setHeader = function (name, value) { this.headers[name] = value }
    res.on('finish', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
  const invokeBinary = (method, url) => invokeBinaryRoutes(routes, method, url)

  const overview = await invoke('GET', PANEL_PREFIX + '/overview')
  assert(overview.status === 200 && overview.body.ok === true, '/overview 200')
  assert(overview.body.root === root, '/overview root')
  const finalCollections = collectionStatus(root)
  const finalStats = stats(root)
  assert(finalStats.collections === 3, '最终应有 3 个集合，实际 ' + finalStats.collections)
  assert(finalStats.docs === 8, '最终应有 8 篇文档（alpha 2 + code 1 + imported 5），实际 ' + finalStats.docs)
  assert(overview.body.collections.length === finalCollections.length, '/overview collections 数量')
  assert(overview.body.stats.collections === finalStats.collections
    && overview.body.stats.docs === finalStats.docs
    && overview.body.stats.chunks === finalStats.chunks
    && overview.body.stats.bytes === finalStats.bytes
    && overview.body.stats.indexBytes === finalStats.indexBytes, '/overview stats 应与 engine.stats 一致')
  for (const item of overview.body.collections) {
    for (const key of ['name', 'backend', 'docs', 'chunks', 'bytes', 'indexedAt', 'indexBytes']) {
      assert(Object.prototype.hasOwnProperty.call(item, key), '/overview collections 缺字段 ' + key)
    }
  }
  assert(overview.body.policy.exists === true && overview.body.policy.default === 'deny', '/overview policy 摘要')
  assert(overview.body.policy.grants.length === 2 && overview.body.policy.deny.length === 1, '/overview policy grants/deny')
  ok('面板 /overview：stats + collections + policy')

  const filesRes = await invoke('GET', PANEL_PREFIX + '/files?collection=alpha')
  assert(filesRes.status === 200 && filesRes.body.ok === true && filesRes.body.collection === 'alpha', '/files 200')
  assert(filesRes.body.total === 2 && filesRes.body.files.length === 2, '/files alpha 应有 2 个文件')
  assert(filesRes.body.files.map((file) => file.path).sort().join(',') === 'alpha/a.md,alpha/b.md', '/files 路径')
  for (const file of filesRes.body.files) {
    assert(typeof file.title === 'string' && typeof file.chunks === 'number' && typeof file.bytes === 'number', '/files 字段')
  }
  ok('面板 /files：集合文件列表')

  const filesMissing = await invoke('GET', PANEL_PREFIX + '/files?collection=nope')
  const filesNone = await invoke('GET', PANEL_PREFIX + '/files')
  assert(filesMissing.status === 404 && filesMissing.body.ok === false, '/files 未知集合应 404')
  assert(filesNone.status === 404, '/files 缺 collection 应 404')
  ok('面板 /files：未知 / 缺失集合 404')

  const searched = await invoke('POST', PANEL_PREFIX + '/search', { query: 'hello' })
  assert(searched.status === 200 && searched.body.ok === true && searched.body.hits.length > 0, '/search 200 且有命中')
  assert(searched.body.scope.collections.join(',') === collectionNames(root).join(','), '/search 未传 workspace 时应覆盖全部集合')
  assert(searched.body.hits.every((hit) => hit.path.startsWith('alpha/')), '/search 命中应来自 alpha')
  ok('面板 /search：普通检索（范围 = 全部集合）')

  const scoped = await invoke('POST', PANEL_PREFIX + '/search', { query: 'hello', workspace: 'C:/X' })
  assert(scoped.body.ok === true && scoped.body.scope.collections.join(',') === 'alpha', 'workspace C:/X 只应看到 alpha，实际 ' + JSON.stringify(scoped.body.scope))
  assert(scoped.body.hits.length > 0 && scoped.body.hits.every((hit) => hit.path.startsWith('alpha/')), 'workspace 过滤后命中应只来自 alpha')
  const mixed = await invoke('POST', PANEL_PREFIX + '/search', { query: 'import', collections: ['alpha', 'imported'], workspace: 'C:/Y' })
  assert(mixed.body.ok === true && mixed.body.scope.collections.join(',') === 'imported', 'collections 与 workspace 应取交集，实际 ' + JSON.stringify(mixed.body.scope))
  assert(mixed.body.hits.length > 0 && mixed.body.hits.every((hit) => hit.path.startsWith('imported/')), '交集命中应只来自 imported')
  ok('面板 /search：workspace ACL 过滤 + collections 交集')

  const badSearch = await invoke('POST', PANEL_PREFIX + '/search', { query: '   ' })
  assert(badSearch.status === 400 && badSearch.body.ok === false, '/search 空 query 应 400')
  ok('面板 /search：空 query 400')

  const readRes = await invoke('POST', PANEL_PREFIX + '/read', { path: 'alpha/a.md', from: 1, lines: 2 })
  assert(readRes.status === 200 && readRes.body.ok === true && readRes.body.text.includes('Alpha A'), '/read 应返回带行号文本')
  assert(readRes.body.totalLines >= 3 && readRes.body.truncated === true, '/read 分页信息')
  const readMissing = await invoke('POST', PANEL_PREFIX + '/read', {})
  assert(readMissing.status === 400 && readMissing.body.ok === false, '/read 缺 path 应 400')
  const readTraversal = await invoke('POST', PANEL_PREFIX + '/read', { path: '../corpus-access.json' })
  assert(readTraversal.status === 500 && readTraversal.body.ok === false, '/read 穿越应返回 500 + ok:false')
  ok('面板 /read：正常读取 / 缺 path 400 / 穿越 500')

  const reindexMissing = await invoke('POST', PANEL_PREFIX + '/reindex', { collection: 'nope' })
  assert(reindexMissing.status === 404 && reindexMissing.body.ok === false, '/reindex 未知集合应 404')
  const reindexRes = await invoke('POST', PANEL_PREFIX + '/reindex', { collection: 'alpha' })
  assert(reindexRes.status === 200 && reindexRes.body.ok === true && reindexRes.body.started === true && reindexRes.body.job, '/reindex 应返回 job')
  const panelDone = await panelJobs.wait(reindexRes.body.job.id, 30000)
  assert(panelDone.state === 'done', '面板触发的重建应完成：' + (panelDone.error || ''))
  const statusRes = await invoke('GET', PANEL_PREFIX + '/status')
  assert(statusRes.status === 200 && statusRes.body.ok === true, '/status 200')
  assert(statusRes.body.active === null && statusRes.body.recent.length >= 1, '/status active 清空、recent 有记录')
  assert(statusRes.body.recent[0].id === reindexRes.body.job.id && statusRes.body.recent[0].state === 'done', '/status recent 记录面板任务')
  assert(Array.isArray(statusRes.body.collections) && statusRes.body.collections.length === 3, '/status 带集合状态')
  ok('面板 /reindex → wait → /status：异步重建闭环')

  const policyRes = await invoke('GET', PANEL_PREFIX + '/policy')
  assert(policyRes.status === 200 && policyRes.body.ok === true && policyRes.body.exists === true, '/policy 200')
  assert(policyRes.body.accessFile === path.join(home, 'corpus-access.json'), '/policy accessFile')
  assert(policyRes.body.default === 'deny', '/policy default')
  assert(policyRes.body.grants.length === 2 && policyRes.body.deny.length === 1, '/policy grants/deny')
  ok('面板 /policy：策略文件摘要')

  // ---- v1.2：右栏权限（/access + POST /policy） ----
  const accessRes = await invoke('GET', PANEL_PREFIX + '/access?session=session-v2')
  assert(accessRes.status === 200 && accessRes.body.ok === true, '/access 200')
  assert(accessRes.body.sessionId === 'session-v2' && accessRes.body.workspace === 'C:/X', '/access session → workspace')
  assert(accessRes.body.workspaceKey === normalize('C:/X'), '/access workspaceKey')
  assert(accessRes.body.effectiveCollections.join(',') === 'alpha', '/access effectiveCollections：' + accessRes.body.effectiveCollections)
  assert(accessRes.body.collections.length === 3, '/access 集合候选数')
  for (const item of accessRes.body.collections) {
    assert(typeof item.name === 'string' && typeof item.backend === 'string' && typeof item.docs === 'number', '/access collections 字段 {name,backend,docs}')
  }
  assert(accessRes.body.policy.grants.length === 2 && accessRes.body.policy.deny.length === 1, '/access policy 摘要')
  ok('面板 /access：session 解析 + 有效集合 + 策略摘要')

  const accessFallback = await invoke('GET', PANEL_PREFIX + '/access?session=ghost&workspace=C:/Y')
  assert(accessFallback.status === 200 && accessFallback.body.workspace === 'C:/Y', '/access fallback workspace')
  assert(accessFallback.body.effectiveCollections.join(',') === 'imported', '/access fallback effectiveCollections')
  const accessEmpty = await invoke('GET', PANEL_PREFIX + '/access?session=ghost')
  assert(accessEmpty.body.effectiveCollections.length === 0, '/access 无 workspace 时为空')
  ok('面板 /access：未知 session fallback / 无 workspace 空范围')

  const policyFile = path.join(home, 'corpus-access.json')
  const policyBefore = JSON.parse(fs.readFileSync(policyFile, 'utf8'))
  const badPolicy = await invoke('POST', PANEL_PREFIX + '/policy', { policy: { default: 'maybe' } })
  assert(badPolicy.status === 400 && badPolicy.body.ok === false && Array.isArray(badPolicy.body.errors) && badPolicy.body.errors.length > 0, '/policy 非法 400 + errors[]')
  assert(JSON.parse(fs.readFileSync(policyFile, 'utf8')).grants.length === policyBefore.grants.length, '/policy 400 不改文件')
  ok('面板 POST /policy：非法策略 400 + errors[]，文件不变')

  const newPolicy = {
    version: 1,
    default: 'deny',
    grants: [
      { workspace: 'C:/X', paths: ['alpha'] },
      { session: 'session-v2', paths: ['imported'], expiresAt: Date.now() + 3600000 },
    ],
    deny: [{ paths: ['**/private/**'] }],
  }
  const savedPolicy = await invoke('POST', PANEL_PREFIX + '/policy', { policy: newPolicy })
  assert(savedPolicy.status === 200 && savedPolicy.body.ok === true, '/policy 合法 200')
  assert(typeof savedPolicy.body.backup === 'string' && fs.existsSync(savedPolicy.body.backup), '/policy 返回备份文件')
  assert(savedPolicy.body.policy.grants.length === 2, '/policy 返回摘要')
  const accessChanged = await invoke('GET', PANEL_PREFIX + '/access?session=session-v2')
  assert(accessChanged.body.effectiveCollections.sort().join(',') === 'alpha,imported', '/policy 保存后 /access 立即反映：' + accessChanged.body.effectiveCollections)
  ok('面板 POST /policy：保存 + 备份 + /access 立即生效')

  // ---- v1.3：导入（/import/targets + POST /import + /import/status） ----
  const targetsRes = await invoke('GET', PANEL_PREFIX + '/import/targets')
  assert(targetsRes.status === 200 && targetsRes.body.ok === true, '/import/targets 200')
  assert(Array.isArray(targetsRes.body.collections) && targetsRes.body.collections.length === 3, '/import/targets 集合候选数')
  for (const item of targetsRes.body.collections) {
    assert(typeof item.name === 'string' && typeof item.backend === 'string' && typeof item.docs === 'number', '/import/targets collections 字段 {name,backend,docs}')
  }
  assert(Array.isArray(targetsRes.body.formats) && targetsRes.body.formats.join(',') === SUPPORTED_EXTENSIONS.join(','), '/import/targets formats 应与 SUPPORTED_EXTENSIONS 一致（19 种），实际 ' + JSON.stringify(targetsRes.body.formats))
  assert(targetsRes.body.formats.length === 19 && targetsRes.body.formats.includes('.gif') && targetsRes.body.formats.includes('.tiff'), '/import/targets formats 应含 gif/tiff（19 种）')
  for (const key of ['pdf', 'office', 'officecli', 'html', 'bundle', 'ocr', 'image']) {
    assert(typeof targetsRes.body.extractors[key] === 'boolean', '/import/targets extractors.' + key + ' 应是布尔值')
  }
  assert(targetsRes.body.extractors.pdf === true && targetsRes.body.extractors.office === true && targetsRes.body.extractors.html === true && targetsRes.body.extractors.image === true, '/import/targets 内置提取器可用')
  assert(targetsRes.body.aiAvailable === true && targetsRes.body.visionAvailable === true, '/import/targets aiAvailable/visionAvailable（来自 ingest 服务）')
  assert(targetsRes.body.limits.maxFiles === 200 && targetsRes.body.limits.maxUploadBytes === 25 * 1024 * 1024, '/import/targets limits {maxFiles,maxUploadBytes}')
  ok('面板 /import/targets：collections/formats(19)/extractors{7}/aiAvailable/visionAvailable/limits')

  const importStarted = await invoke('POST', PANEL_PREFIX + '/import', { path: '/tmp/demo.md', collection: 'alpha', prefix: 'inbox', ai: false })
  assert(importStarted.status === 200 && importStarted.body.ok === true && importStarted.body.started === true && importStarted.body.job.id === 'ingest-fake-1', 'POST /import path 方式应返回 started + job')
  const pathCall = fakeIngest.startCalls[fakeIngest.startCalls.length - 1]
  assert(pathCall.paths.length === 1 && pathCall.paths[0] === '/tmp/demo.md' && pathCall.collection === 'alpha' && pathCall.prefix === 'inbox', 'POST /import 应把 body.path 映射到 start({paths:[…]})')
  assert(pathCall.ai === false && pathCall.index === true, 'POST /import ai:false 透传、index 默认 true')
  const importFiles = await invoke('POST', PANEL_PREFIX + '/import', { files: [{ name: 'u.md', dataBase64: 'aGVsbG8=' }], collection: 'alpha' })
  assert(importFiles.status === 200 && importFiles.body.started === true, 'POST /import files 方式 200 + started')
  const filesCall = fakeIngest.startCalls[fakeIngest.startCalls.length - 1]
  assert(filesCall.uploads.length === 1 && filesCall.uploads[0].name === 'u.md' && filesCall.paths.length === 0, 'POST /import 应把 body.files 映射到 uploads')
  assert(filesCall.ai === true, 'POST /import 未传 ai 时默认 true')
  ok('面板 POST /import：path 与 files 两种 body 映射 + started/job')

  const importBusy = await invoke('POST', PANEL_PREFIX + '/import', { collection: 'busy-collection' })
  assert(importBusy.status === 200 && importBusy.body.ok === false && importBusy.body.started === false && importBusy.body.busy === true && importBusy.body.job.id === 'ingest-busy-1', 'POST /import 已有任务应 200 + busy:true + job')
  const importBad = await invoke('POST', PANEL_PREFIX + '/import', { collection: 'bad/name' })
  assert(importBad.status === 400 && importBad.body.ok === false && String(importBad.body.error).includes('集合名'), 'POST /import 校验失败应 400 + error')
  ok('面板 POST /import：已有任务 busy 形态 / 校验失败 400')

  const importStatus = await invoke('GET', PANEL_PREFIX + '/import/status')
  assert(importStatus.status === 200 && importStatus.body.ok === true, '/import/status 200')
  assert(importStatus.body.active && importStatus.body.active.id === 'ingest-fake-1' && importStatus.body.active.current.stage === 'extract', '/import/status active + current.stage')
  assert(Array.isArray(importStatus.body.recent) && importStatus.body.recent.length === 1 && importStatus.body.recent[0].state === 'done', '/import/status recent')
  ok('面板 /import/status：active（含 current.stage）+ recent')

  // 没有 ingest 服务时：targets 仍 200（默认 limits）、status 空、POST /import 503（避免宿主半部崩溃）
  const noIngestRoutes = createPanelRoutes({ root, dshHome: home, jobs: panelJobs, sessionLookup })
  const targetsNoIngest = await invokeRoutes(noIngestRoutes, 'GET', PANEL_PREFIX + '/import/targets')
  assert(targetsNoIngest.status === 200 && targetsNoIngest.body.ok === true && targetsNoIngest.body.aiAvailable === false && targetsNoIngest.body.visionAvailable === false, '/import/targets 无 ingest 服务时仍 200，ai/vision=false')
  assert(targetsNoIngest.body.limits.maxFiles === 200 && targetsNoIngest.body.limits.maxUploadBytes === 25 * 1024 * 1024, '/import/targets 无 ingest 服务时用默认 limits')
  const statusNoIngest = await invokeRoutes(noIngestRoutes, 'GET', PANEL_PREFIX + '/import/status')
  assert(statusNoIngest.status === 200 && statusNoIngest.body.active === null && statusNoIngest.body.recent.length === 0, '/import/status 无 ingest 服务时返回空')
  const importNoIngest = await invokeRoutes(noIngestRoutes, 'POST', PANEL_PREFIX + '/import', { collection: 'alpha' })
  assert(importNoIngest.status === 503 && importNoIngest.body.ok === false, 'POST /import 无 ingest 服务时 503')
  ok('导入路由降级：无 ingest 服务时 targets/status 可用、POST 503')

  // ---- v1.5：语料库根目录设置（GET /settings + POST /settings/root 的忙/非法路径） ----
  // 不在这里做真实迁移（迁移语义由 test-settings.mjs 用临时根覆盖）：
  // 这个面板挂着 fake 导入任务，正好验证 busy 标记与 409；400 用一定会被拒绝的目标。
  const settingsRes = await invoke('GET', PANEL_PREFIX + '/settings')
  assert(settingsRes.status === 200 && settingsRes.body.ok === true, 'GET /settings 200')
  assert(settingsRes.body.root === root && settingsRes.body.runtimeRoot === root, 'GET /settings 返回运行中的根目录: ' + JSON.stringify(settingsRes.body.root))
  assert(settingsRes.body.stateFile === path.join(home, 'corpus-root.json'), 'GET /settings stateFile 应为 <DSH_HOME>/corpus-root.json，实际 ' + settingsRes.body.stateFile)
  assert(settingsRes.body.state === null, 'GET /settings 未迁移时 state 应为 null')
  assert(settingsRes.body.exists === true && settingsRes.body.writable === true, 'GET /settings exists/writable')
  assert(settingsRes.body.collections === collectionNames(root).length, 'GET /settings collections 数量，实际 ' + settingsRes.body.collections)
  assert(settingsRes.body.busy === true && settingsRes.body.activeIngest !== null && settingsRes.body.activeJob === null, 'GET /settings busy 应来自运行中的导入任务')
  ok('面板 GET /settings：root/runtimeRoot/stateFile/state/exists/writable/busy/activeIngest')

  const migrateBusy = await invoke('POST', PANEL_PREFIX + '/settings/root', { root: path.join(tmp, 'corpus-next') })
  assert(migrateBusy.status === 409 && migrateBusy.body.ok === false && migrateBusy.body.busy === true, 'POST /settings/root 有导入任务时应 409 + busy:true，实际 ' + migrateBusy.status)
  assert(fs.existsSync(path.join(tmp, 'corpus-next')) === false, 'POST /settings/root 被 409 拒绝时不应创建目标目录')
  const settingsIdle = await invokeRoutes(noIngestRoutes, 'GET', PANEL_PREFIX + '/settings')
  assert(settingsIdle.status === 200 && settingsIdle.body.busy === false && settingsIdle.body.activeIngest === null, 'GET /settings 无任务时 busy:false')
  const migrateNested = await invokeRoutes(noIngestRoutes, 'POST', PANEL_PREFIX + '/settings/root', { root: path.join(root, 'nested') })
  assert(migrateNested.status === 400 && migrateNested.body.ok === false && String(migrateNested.body.error).includes('内部'), 'POST /settings/root 目标位于当前根内部应 400：' + migrateNested.body.error)
  assert(fs.existsSync(path.join(root, 'nested')) === false, 'POST /settings/root 校验失败时不应创建目标目录')
  // settings.js 修复后：相对路径/空路径必须在 path.resolve 之前拒绝，不能落到进程 cwd 做真实迁移。
  const migrateRelative = await invokeRoutes(noIngestRoutes, 'POST', PANEL_PREFIX + '/settings/root', { root: 'relative-corpus' })
  assert(migrateRelative.status === 400 && migrateRelative.body.ok === false && String(migrateRelative.body.error).includes('绝对路径'), 'POST /settings/root 相对路径应 400：' + migrateRelative.body.error)
  const migrateEmpty = await invokeRoutes(noIngestRoutes, 'POST', PANEL_PREFIX + '/settings/root', {})
  assert(migrateEmpty.status === 400 && migrateEmpty.body.ok === false && String(migrateEmpty.body.error).includes('绝对路径'), 'POST /settings/root 空路径应 400：' + migrateEmpty.body.error)
  assert(fs.existsSync(path.join(process.cwd(), 'relative-corpus')) === false, 'POST /settings/root 相对路径不应被解析到进程 cwd')
  ok('面板 POST /settings/root：任务运行中 409 / 目标嵌套 400 / 相对或空路径 400')


  const crossSite = await invoke('GET', PANEL_PREFIX + '/overview', undefined, { origin: 'http://evil.test' })
  const crossPolicy = await invoke('POST', PANEL_PREFIX + '/policy', { policy: newPolicy }, { origin: 'http://evil.test' })
  assert(crossSite.status === 403 && crossPolicy.status === 403, '跨站 origin 应 403')
  const sameSite = await invoke('GET', PANEL_PREFIX + '/overview', undefined, { origin: 'http://127.0.0.1:1234' })
  assert(sameSite.status === 200 && sameSite.body.ok === true, '同源 origin 应放行')
  ok('面板同源校验：跨站 403 / 同源放行')

  const methodSearch = await invoke('GET', PANEL_PREFIX + '/search')
  const methodOverview = await invoke('POST', PANEL_PREFIX + '/overview', {})
  const methodStatus = await invoke('POST', PANEL_PREFIX + '/status')
  const methodAccess = await invoke('POST', PANEL_PREFIX + '/access', {})
  const methodPolicy = await invoke('PUT', PANEL_PREFIX + '/policy', {})
  const methodImport = await invoke('GET', PANEL_PREFIX + '/import')
  const methodTargets = await invoke('POST', PANEL_PREFIX + '/import/targets', {})
  const methodImportStatus = await invoke('POST', PANEL_PREFIX + '/import/status', {})
  const methodSettings = await invoke('POST', PANEL_PREFIX + '/settings', {})
  const methodSettingsRoot = await invoke('GET', PANEL_PREFIX + '/settings/root')
  const methodSettingsOpen = await invoke('GET', PANEL_PREFIX + '/settings/open')
  assert(
    methodSearch.status === 405 && methodOverview.status === 405 && methodStatus.status === 405
    && methodAccess.status === 405 && methodPolicy.status === 405
    && methodImport.status === 405 && methodTargets.status === 405 && methodImportStatus.status === 405
   
    && methodSettings.status === 405 && methodSettingsRoot.status === 405 && methodSettingsOpen.status === 405,
    '方法不匹配应 405（含 v1.3 导入与 v1.5 /settings 路由）',
  )
  ok('面板方法限制：GET/POST 不匹配返回 405（含 /import/* 与 /settings 系列）')

  // -------------------------------------------------------------------------
  // 7. importInto 输出限流与单次上限（契约 1.1 修订：fileCount / files ≤ 100）
  // -------------------------------------------------------------------------
  const bulk = path.join(tmp, 'bulk')
  fs.mkdirSync(bulk, { recursive: true })
  for (let index = 0; index < 105; index++) {
    fs.writeFileSync(path.join(bulk, 'doc-' + String(index).padStart(3, '0') + '.md'), '# Bulk ' + index + '\n\nbulk content ' + index + '\n')
  }
  const bulkResult = importInto(root, { source: bulk, collection: 'bulk' })
  assert(bulkResult.ok === true && bulkResult.imported === 105 && bulkResult.fileCount === 105, '应导入 105 个文件，fileCount=105')
  assert(bulkResult.files.length === 100 && bulkResult.filesTruncated === true, 'files 应限流为 100 条并标记 filesTruncated')
  assert(bulkResult.truncated === false, '未达 maxFiles 上限，不应 truncated')
  ok('importInto 输出限流：fileCount / files≤100 / filesTruncated')

  const cappedResult = importInto(root, { source: bulk, collection: 'bulk', prefix: 'cap', maxFiles: 2 })
  assert(cappedResult.imported === 2 && cappedResult.truncated === true && cappedResult.skipped === 103, 'maxFiles=2 时应导入 2 个、跳过 103 个并置 truncated')
  assert(cappedResult.notes.some((note) => note.includes('上限')), 'notes 应记录单次上限')
  ok('importInto 单次上限：maxFiles 截断并计入 skipped/notes')
} finally {
  for (const runner of runners) {
    try { runner.dispose() } catch { /* 已关闭 */ }
  }
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('\n全部通过: ' + pass + ' 项')
