/**
 * dsh-plugin-corpus v1.3 — 导入任务（ingest.js）验收测试（新）。
 *
 * 自包含：在 os.tmpdir() 下造临时语料根与源文件，不读写 ~/.dsh；
 * 用 fake agent（available/supportsImages/structure）与 fake reindex（jobs.start），
 * 不调用任何真实模型、不启动 worker。
 *
 * v1.3 最终目录布局（每个导入文件一个独立文件夹）：
 *   <root>/<collection>/[<prefix>/]<YYYYMMDD-HHmmss>-<源文件slug>/
 *     ├ originals/<原文件名>        （所有格式都保留原件）
 *     ├ processed/<标题slug>.md     （front matter: title/source/format/importedAt/collection/original/aiStructured）
 *     └ .meta.json                  （source/original/processed/title/format/mediaType/importedAt/aiStructured/bytes/warnings）
 *
 * 覆盖：目录导入、每文件文件夹布局、原件入档、.meta.json、front matter、items[].target/original/folder、
 * reindexJobId、import-tmp 清理、uploads base64、prefix（反斜杠/绝对前缀归一，不越界）、
 * 同源重复导入不覆盖（独立文件夹）、AI 回退、ai:false、失败计数、job error、current.stage。
 *
 * 运行（DSH 自带 Node 24）：
 *   & "…\dependencies\node\bin\node.exe" tests\test-ingest.mjs
 * 输出：PASS 行 + 末尾「全部通过: N 项」；失败抛错、退出码非 0。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createIngestManager } from '../plugin/lib/ingest.js'

let pass = 0
const ok = (label) => { pass++; console.log('  PASS ' + label) }
const assert = (condition, message) => { if (!condition) throw new Error('ASSERT: ' + message) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function expectThrows(fn, label, needle) {
  let error = null
  try { fn() } catch (caught) { error = caught }
  if (error === null) throw new Error('应当被拒绝却成功了：' + label)
  if (needle && !String(error && error.message).includes(needle)) {
    throw new Error(`拒绝原因不符（${label}）：期望包含「${needle}」，实际「${error && error.message}」`)
  }
  return error
}

const FOLDER_RE = /^\d{8}-\d{6}-[A-Za-z0-9\u4e00-\u9fff._-]+(?:-\d+)?$/

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-ingest-'))
const root = path.join(tmp, 'corpus')
const home = path.join(tmp, 'home')
const src = path.join(tmp, 'source')

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

fs.mkdirSync(root, { recursive: true })
fs.mkdirSync(home, { recursive: true })
const readmeFile = writeFile(path.join(src, 'readme.md'), '# Readme Title\n\nalpha unique keyword from markdown\n')
const htmlFile = writeFile(path.join(src, 'page.html'), '<html><head><title>HTML Page</title></head><body><h1>HTML Heading</h1><p>html unique token</p></body></html>')
const nestedFile = writeFile(path.join(src, 'deep', 'nested.txt'), 'nested text only\n')
writeFile(path.join(src, '.hidden.md'), '# Hidden\n\nmust be skipped\n')
writeFile(path.join(src, 'ignored.bin'), Buffer.from([0x00, 0x01, 0x02]))

/** 假小代理：记录调用；fail=true 时模拟模型错误。 */
function createFakeAgent({ fail = false, delayMs = 0 } = {}) {
  const agent = {
    calls: [],
    available: () => true,
    route: () => ({ provider: 'fake-provider', model: 'fake-model' }),
    supportsImages: async () => false,
    structure: async ({ text, meta }) => {
      agent.calls.push({ text, meta })
      if (delayMs > 0) await sleep(delayMs)
      if (fail) throw new Error('fake model exploded')
      return '# AI 结构化标题\n\n## 摘要\n\n- 自动摘要要点\n\n## 关键要点\n\n- 来自 fake agent\n'
    },
    structureImages: async () => { throw new Error('本测试不涉及图片') },
  }
  return agent
}

/** 假重建任务管理器。 */
function createFakeReindex() {
  const calls = []
  return {
    calls,
    start(options) {
      calls.push(options)
      return { started: true, job: { id: 'job-fake-' + calls.length, state: 'running', names: options.names } }
    },
    status() { return { active: null, recent: [] } },
  }
}

const managers = []
function makeManager({ agent, reindex } = {}) {
  const manager = createIngestManager({
    root,
    dshHome: home,
    reindex: reindex || createFakeReindex(),
    agent: agent || createFakeAgent(),
    config: { ingestMaxChars: 24000, ingestTimeoutMs: 120000 },
    log: () => {},
  })
  managers.push(manager)
  return manager
}

async function waitIngest(manager, jobId, timeoutMs = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const status = manager.status()
    const job = status.recent.find((item) => item.id === jobId)
      || (status.active && status.active.id === jobId ? status.active : null)
    if (job && job.state !== 'running') return job
    await sleep(15)
  }
  throw new Error('等待导入任务超时：' + jobId)
}

function readFrontMatter(file) {
  const text = fs.readFileSync(file, 'utf8')
  const match = text.match(/^---\n([\s\S]*?)\n---\n/)
  assert(match !== null, '写出的 Markdown 应带 front matter：' + file)
  const front = {}
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([A-Za-z]+): (.*)$/)
    if (!kv) continue
    front[kv[1]] = kv[2]
  }
  return { front, body: text.slice(match[0].length), text }
}

function absOf(relTarget) {
  return path.join(root, ...String(relTarget).split('/'))
}

/** item.target = <collection>/[prefix/]<folder>/processed/<slug>.md */
function folderOfTarget(target) {
  const parts = String(target).split('/')
  const at = parts.indexOf('processed')
  assert(at > 0 && parts[at + 1] && parts[at + 1].endsWith('.md'), 'items[].target 应指向 processed/<slug>.md，实际 ' + target)
  return parts[at - 1]
}

try {
  // -------------------------------------------------------------------------
  // 1. 目录导入：running→done、计数、items、recent 快照
  // -------------------------------------------------------------------------
  const reindex1 = createFakeReindex()
  const agent1 = createFakeAgent()
  const manager = makeManager({ agent: agent1, reindex: reindex1 })
  const started = manager.start({ paths: [src], collection: 'docs', prefix: 'inbox' })
  assert(started.started === true && started.job.state === 'running', '导入任务应已启动且 state=running，实际 ' + JSON.stringify(started))
  const running = manager.status().active
  assert(running !== null && running.id === started.job.id, 'status.active 应是正在运行的任务')
  for (const key of ['id', 'state', 'collection', 'prefix', 'ai', 'index', 'startedAt', 'total', 'done', 'failed', 'current', 'items', 'result', 'error', 'reindexJobId']) {
    assert(Object.prototype.hasOwnProperty.call(running, key), 'job 快照缺字段 ' + key)
  }
  assert(running.collection === 'docs' && running.prefix === 'inbox' && running.ai === true && running.index === true, 'job 的 collection/prefix/ai/index')
  const jobId = started.job.id
  const done = await waitIngest(manager, jobId)
  assert(done.state === 'done', '任务应完成，实际 ' + done.state + '：' + (done.error || ''))
  assert(done.total === 3 && done.done === 3 && done.failed === 0, `目录导入应 3/3 成功（md+html+txt，跳过隐藏/二进制），实际 total=${done.total} done=${done.done} failed=${done.failed}`)
  assert(done.current === null && typeof done.finishedAt === 'number' && typeof done.ms === 'number', '完成后 current 清空、finishedAt/ms 有值')
  assert(done.items.length === 3 && done.items.every((item) => item.ok === true && item.aiStructured === true), 'items：3 个成功且 aiStructured=true')
  assert(manager.status().active === null && manager.status().recent.some((item) => item.id === jobId && item.state === 'done'), 'status.active 清空、recent 保留任务')
  ok('目录导入：running→done、total/done/failed、items、recent 快照')

  // -------------------------------------------------------------------------
  // 2. 每文件一个独立文件夹：processed/.meta.json，不保存源文件
  // -------------------------------------------------------------------------
  const readmeItem = done.items.find((item) => item.source === 'readme.md')
  assert(readmeItem && readmeItem.ok === true, '应包含 readme.md 的 item')
  const readmeFolder = folderOfTarget(readmeItem.target)
  assert(FOLDER_RE.test(readmeFolder) && readmeFolder.endsWith('-readme'), '文件夹名应为 <stamp>-readme，实际 ' + readmeFolder)
  assert(readmeItem.folder === readmeFolder, 'items[].folder 应与路径中的文件夹一致')
  assert(readmeItem.target === `docs/inbox/${readmeFolder}/processed/AI-结构化标题.md`, 'items[].target 应指向 processed/<标题slug>.md，实际 ' + readmeItem.target)
  assert(fs.existsSync(absOf(readmeItem.target)), 'processed Markdown 应落盘：' + absOf(readmeItem.target))
  assert(!fs.existsSync(absOf(`docs/inbox/${readmeFolder}/originals`)), '不应再创建 originals/ 目录')
  assert(readmeItem.original === undefined, 'items[] 不应再返回 original')
  const folders = new Set(done.items.map((item) => item.folder))
  assert(folders.size === 3 && done.items.every((item) => FOLDER_RE.test(item.folder)), '3 个文件应有 3 个独立导入文件夹，实际 ' + JSON.stringify([...folders]))
  assert(done.items.every((item) => String(item.target).includes('/processed/') && item.original === undefined), '每个 item 只应有 processed 路径')
  ok('导入布局：每个文件一个文件夹 + processed/.meta.json，不保存源文件')

  const readmeDoc = readFrontMatter(absOf(readmeItem.target))
  assert(readmeDoc.front.title === '"AI 结构化标题"', 'front matter title 应取 AI 标题，实际 ' + readmeDoc.front.title)
  assert(readmeDoc.front.source === '"readme.md"', 'front matter source')
  assert(readmeDoc.front.format === '"md"', 'front matter format=md')
  assert(readmeDoc.front.collection === '"docs"', 'front matter collection=docs')
  assert(typeof readmeDoc.front.importedAt === 'string' && !Number.isNaN(Date.parse(JSON.parse(readmeDoc.front.importedAt))), 'front matter importedAt 应是 ISO 时间')
  assert(readmeDoc.front.aiStructured === 'true', 'front matter aiStructured=true')
  assert(readmeDoc.front.original === undefined, 'front matter 不应再写 original')
  assert(readmeDoc.body.includes('# AI 结构化标题') && readmeDoc.body.includes('- 来自 fake agent'), '正文应是 AI 返回的 Markdown 原文')
  const htmlItem = done.items.find((item) => item.source === 'page.html')
  const htmlDoc = readFrontMatter(absOf(htmlItem.target))
  assert(htmlDoc.front.format === '"html"' && htmlDoc.front.original === undefined, 'html item 的 front matter format 且无 original')
  ok('front matter：title/source/format/importedAt/collection/aiStructured（不再记录原件）')

  const meta = JSON.parse(fs.readFileSync(absOf(`docs/inbox/${readmeFolder}/.meta.json`), 'utf8'))
  for (const key of ['source', 'processed', 'title', 'format', 'mediaType', 'importedAt', 'aiStructured', 'bytes', 'warnings']) {
    assert(Object.prototype.hasOwnProperty.call(meta, key), '.meta.json 缺字段 ' + key)
  }
  assert(meta.source === 'readme.md' && meta.processed === readmeItem.target && meta.original === undefined, '.meta.json 的 source/processed 且无 original')
  assert(meta.title === 'AI 结构化标题' && meta.format === 'md' && meta.aiStructured === true, '.meta.json 的 title/format/aiStructured')
  assert(meta.bytes === fs.statSync(readmeFile).size && Array.isArray(meta.warnings), '.meta.json 的 bytes/warnings')
  ok('导入文件夹 .meta.json：source/processed/title/format/mediaType/importedAt/aiStructured/bytes/warnings')

  assert(agent1.calls.length === 3, 'agent.structure 应被调用 3 次，实际 ' + agent1.calls.length)
  const htmlCall = agent1.calls.find((call) => call.meta.source === 'page.html')
  assert(htmlCall && htmlCall.meta.collection === 'docs' && htmlCall.meta.format === 'html' && htmlCall.text.includes('html unique token'), 'agent 入参应含提取文本与 meta（source/format/collection）')
  const mdCall = agent1.calls.find((call) => call.meta.source === 'readme.md')
  assert(mdCall && mdCall.text.includes('alpha unique keyword'), 'agent 入参应含 markdown 正文')
  ok('agent 入参：text + meta（title/source/format/collection/warnings）')

  // -------------------------------------------------------------------------
  // 3. reindexJobId + 上传临时目录清理
  // -------------------------------------------------------------------------
  assert(reindex1.calls.length === 1 && reindex1.calls[0].names.join(',') === 'docs', '完成后应以 [collection] 触发一次重建，实际 ' + JSON.stringify(reindex1.calls))
  assert(done.reindexJobId === 'job-fake-1', 'job.reindexJobId 应来自 reindex.start 的 job.id，实际 ' + done.reindexJobId)
  assert(done.result && done.result.reindexJobId === 'job-fake-1', 'job.result.reindexJobId')
  assert(done.result.collection === 'docs' && done.result.total === 3 && done.result.imported === 3 && done.result.failed === 0, 'job.result 汇总字段')
  assert(!fs.existsSync(path.join(root, '.corpus', 'import-tmp', jobId)), '任务结束后应清理 .corpus/import-tmp/<jobId>')
  ok('reindexJobId（reindex.start({names:[collection]}) + result.reindexJobId）+ import-tmp 清理')

  // -------------------------------------------------------------------------
  // 4. uploads（base64）+ prefix + ai:false + 原件入档
  // -------------------------------------------------------------------------
  const uploadReindex = createFakeReindex()
  const uploadAgent = createFakeAgent()
  const manager2 = makeManager({ agent: uploadAgent, reindex: uploadReindex })
  const uploadBody = '# Upload One\n\nuploaded body unique token\n'
  const uploadBase64 = Buffer.from(uploadBody, 'utf8').toString('base64')
  const uploadStarted = manager2.start({
    uploads: [
      { name: 'upload.md', dataBase64: uploadBase64 },
      { name: 'ignored.bin', dataBase64: Buffer.from([0x01, 0x02]).toString('base64') },
    ],
    collection: 'uploads',
    prefix: 'zone',
    ai: false,
  })
  const uploadDone = await waitIngest(manager2, uploadStarted.job.id)
  assert(uploadDone.state === 'done' && uploadDone.total === 1 && uploadDone.done === 1 && uploadDone.failed === 0, 'upload 导入应成功 1 个、忽略不支持格式：' + JSON.stringify(uploadDone.result))
  assert(uploadDone.result.errors.some((item) => item.includes('不支持的格式')), '不支持的 upload 扩展名应记录在 result.errors')
  assert(uploadAgent.calls.length === 0, 'ai:false 时不应调用 agent.structure')
  const uploadItem = uploadDone.items[0]
  assert(uploadItem.aiStructured === false, 'ai:false 时 item.aiStructured=false')
  assert(/^uploads\/zone\/\d{8}-\d{6}-upload\/processed\/Upload-One\.md$/.test(uploadItem.target), 'target 应为 uploads/zone/<stamp>-upload/processed/Upload-One.md，实际 ' + uploadItem.target)
  assert(uploadItem.original === undefined, 'uploads 不再返回 original')
  assert(!fs.existsSync(absOf(`uploads/zone/${uploadItem.folder}/originals`)), 'uploads 不创建 originals/')
  const uploadDoc = readFrontMatter(absOf(uploadItem.target))
  assert(uploadDoc.front.aiStructured === 'false' && uploadDoc.front.source === '"upload.md"', 'ai:false 的 front matter')
  assert(uploadDoc.body.includes('# Upload One') && uploadDoc.body.includes('> 导入自 upload.md（md）。'), '确定性回退正文：标题 + 来源 + 正文')
  ok('uploads（base64）：独立文件夹 + prefix + ai:false 不走 agent + 确定性 Markdown，不保存源文件')

  // 同源重复导入：不覆盖，每次都开新文件夹（folder 冲突时自动 -2）
  const uploadAgain = manager2.start({ uploads: [{ name: 'upload.md', dataBase64: uploadBase64 }], collection: 'uploads', prefix: 'zone', ai: false })
  const againDone = await waitIngest(manager2, uploadAgain.job.id)
  assert(againDone.state === 'done' && againDone.done === 1, '第二次导入同源文件应成功')
  assert(againDone.items[0].folder !== uploadItem.folder, '同源重复导入应写入不同文件夹（不覆盖），实际 ' + againDone.items[0].folder)
  assert(fs.existsSync(absOf(uploadItem.target)) && fs.existsSync(absOf(againDone.items[0].target)), '两次导入的 processed Markdown 都应存在')
  assert(FOLDER_RE.test(againDone.items[0].folder), '重复导入的文件夹名仍符合 <stamp>-<slug>[-N]')
  ok('同源重复导入：每次独立文件夹（不覆盖 processed/originals）')

  // prefix 归一：反斜杠 → /，绝对前缀被归一为集合内相对路径（不越界）
  const prefixManager = makeManager()
  const prefixStarted = prefixManager.start({
    uploads: [{ name: 'prefixed.md', dataBase64: Buffer.from('# Prefixed Doc\n\ntext\n').toString('base64') }],
    collection: 'docs',
    prefix: '/win\\sub/',
    ai: false,
  })
  const prefixDone = await waitIngest(prefixManager, prefixStarted.job.id)
  const prefixTarget = prefixDone.items[0].target
  assert(prefixDone.state === 'done', 'prefix 导入应成功')
  assert(/^docs\/win\/sub\/\d{8}-\d{6}-prefixed\/processed\/Prefixed-Doc\.md$/.test(prefixTarget), '反斜杠/绝对前缀应归一为集合内相对路径，实际 ' + prefixTarget)
  assert(path.resolve(root, ...prefixTarget.split('/')).startsWith(path.resolve(root, 'docs') + path.sep), 'prefix 写入必须落在 <root>/<collection>/ 内')
  ok('prefix 归一：反斜杠与绝对前缀不越界（落在 <root>/<collection>/）')

  // -------------------------------------------------------------------------
  // 5. 失败输入与失败计数
  // -------------------------------------------------------------------------
  const failManager = makeManager()
  const mixedStarted = failManager.start({
    paths: [readmeFile, path.join(tmp, 'does-not-exist.md'), path.join(src, 'ignored.bin')],
    collection: 'mixed',
    ai: false,
  })
  const mixedDone = await waitIngest(failManager, mixedStarted.job.id)
  assert(mixedDone.state === 'done' && mixedDone.total === 1 && mixedDone.done === 1 && mixedDone.failed === 0, '混合输入中只应导入合法文件：' + JSON.stringify(mixedDone.result))
  assert(Array.isArray(mixedDone.result.errors) && mixedDone.result.errors.length === 2, 'result.errors 应记录 2 条（不存在 + 不支持格式），实际 ' + JSON.stringify(mixedDone.result.errors))
  assert(mixedDone.result.errors.some((item) => item.includes('找不到')) && mixedDone.result.errors.some((item) => item.includes('不支持的格式')), 'result.errors 内容')
  ok('失败输入：不存在路径 / 不支持格式记入 result.errors，job 仍 done')

  const emptyFile = writeFile(path.join(tmp, 'empty.md'), '   \n\n')
  const emptyManager = makeManager()
  const emptyStarted = emptyManager.start({ paths: [emptyFile], collection: 'empty', ai: true })
  const emptyDone = await waitIngest(emptyManager, emptyStarted.job.id)
  assert(emptyDone.state === 'done' && emptyDone.total === 1 && emptyDone.done === 0 && emptyDone.failed === 1, '空文本应计数为失败：' + JSON.stringify(emptyDone.result))
  assert(emptyDone.items[0].ok === false && String(emptyDone.items[0].error).includes('没有提取到文本'), '空文本 item 应带 error')
  assert(emptyDone.reindexJobId === null && emptyDone.finishedAt !== null, '没有成功导入时不应触发重建')
  assert(!fs.existsSync(path.join(root, 'empty')), '空文本在提取阶段失败，不应创建导入文件夹')
  ok('失败计数：空文本 item failed=1 / done=0 / 不建文件夹 / 不触发 reindex')

  // -------------------------------------------------------------------------
  // 6. AI 抛错 → 确定性回退 + warning
  // -------------------------------------------------------------------------
  const failingAgent = createFakeAgent({ fail: true })
  const fallbackManager = makeManager({ agent: failingAgent })
  const fallbackStarted = fallbackManager.start({
    uploads: [{ name: 'fallback.md', dataBase64: Buffer.from('# Fallback Doc\n\nfallback body\n').toString('base64') }],
    collection: 'fallback',
    ai: true,
  })
  const fallbackDone = await waitIngest(fallbackManager, fallbackStarted.job.id)
  assert(fallbackDone.state === 'done' && fallbackDone.done === 1, 'AI 失败不应让整条导入失败: ' + JSON.stringify(fallbackDone.result))
  const fallbackItem = fallbackDone.items[0]
  assert(fallbackItem.aiStructured === false, 'AI 失败回退后 aiStructured=false')
  assert(Array.isArray(fallbackItem.warnings) && fallbackItem.warnings.some((item) => item.includes('小代理结构化失败，已回退')), 'item.warnings 应记录回退原因，实际 ' + JSON.stringify(fallbackItem.warnings))
  assert(failingAgent.calls.length === 1, 'AI 只应尝试一次')
  const fallbackDoc = readFrontMatter(absOf(fallbackItem.target))
  assert(fallbackDoc.front.aiStructured === 'false' && fallbackDoc.body.includes('# Fallback Doc') && fallbackDoc.body.includes('> 导入自 fallback.md（md）。'), '回退内容应是确定性 Markdown（标题 + 来源 + 正文）')
  assert(fallbackDoc.front.original === undefined, '回退时 front matter 不再记录原件')
  ok('AI 抛错：确定性 Markdown 回退 + item.warning + aiStructured=false')

  // -------------------------------------------------------------------------
  // 7. current.stage 可观测（extract/agent/write 阶段）
  // -------------------------------------------------------------------------
  const slowAgent = createFakeAgent({ delayMs: 120 })
  const stageManager = makeManager({ agent: slowAgent })
  const stageStarted = stageManager.start({
    uploads: [{ name: 'staged.md', dataBase64: Buffer.from('# Staged Doc\n\nstaged body\n').toString('base64') }],
    collection: 'staged',
    ai: true,
  })
  const stages = new Set()
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const status = stageManager.status()
    if (status.active && status.active.current && typeof status.active.current.stage === 'string') stages.add(status.active.current.stage)
    if (!status.active) break
    await sleep(10)
  }
  await waitIngest(stageManager, stageStarted.job.id)
  assert(stages.has('agent'), '轮询应能看到 current.stage=agent（实际 ' + [...stages].join(',') + '）')
  assert([...stages].every((stage) => ['extract', 'agent', 'write', 'index', 'error'].includes(stage)), 'stage 取值应在契约集合内，实际 ' + [...stages].join(','))
  ok('job 进度：轮询可见 current.stage（extract/agent/write 之一）与 source/index/total')

  // -------------------------------------------------------------------------
  // 8. 参数校验 + job error 状态
  // -------------------------------------------------------------------------
  expectThrows(() => manager.start({ collection: 'docs' }), '没有 path/files', '至少提供一个 path 或 files')
  expectThrows(() => manager.start({ paths: [readmeFile], collection: '' }), '空集合名', '集合名')
  for (const bad of ['..', '.hidden', 'bad/name', 'a/b', 'x'.repeat(65)]) {
    expectThrows(() => manager.start({ paths: [readmeFile], collection: bad }), '非法集合名 ' + JSON.stringify(bad.slice(0, 12)), '集合名')
  }
  for (const bad of ['..', 'a/../b', 'a//b']) {
    expectThrows(() => manager.start({ paths: [readmeFile], collection: 'docs', prefix: bad }), '非法 prefix ' + JSON.stringify(bad), 'prefix 不能包含')
  }
  ok('参数校验：无来源 / 空 / 非法集合名 / 非法 prefix 抛错')

  const nothingManager = makeManager()
  const nothingStarted = nothingManager.start({ paths: [path.join(tmp, 'no-such-dir')], collection: 'nothing' })
  const nothingDone = await waitIngest(nothingManager, nothingStarted.job.id)
  assert(nothingDone.state === 'error' && String(nothingDone.error).includes('没有找到可导入的文档'), '没有任何可导入文件时 job.state 应为 error，实际 ' + nothingDone.state + ' / ' + nothingDone.error)
  assert(nothingDone.done === 0 && nothingDone.failed === 0, 'error 任务计数应为 0')
  ok('job error 状态：路径全部无效 → state=error + 「没有找到可导入的文档」')

  console.log('\n全部通过: ' + pass + ' 项')
} finally {
  for (const manager of managers) {
    try { manager.dispose() } catch { /* 已关闭 */ }
  }
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 })
}
