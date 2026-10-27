/**
 * dsh-plugin-corpus v1.4 — 仓库/内容结构化服务（plugin/lib/structure.js）验收测试（新）。
 *
 * 自包含：在 os.tmpdir() 下造临时语料根、临时「仓库」（.git/config + HEAD + refs + README +
 * package.json + src/*.js）与普通文件，不读写 ~/.dsh、不部署、不重启。
 * 用 fake agent（available/route/structure，记录入参）与 fake reindex（记录 start 调用），
 * **不调用任何真实模型**、不启动 worker、不碰真实语料。
 *
 * 覆盖：
 *   · 仓库：kind=repo、git remote/branch/commit、扫描跳过 .git/node_modules/dist/隐藏/二进制/符号链接；
 *   · 产物布局：<collection>/[prefix/]<YYYYMMDD-HHmmss>-<标题slug>/{originals/repo.json(+README 快照),
 *     processed/<标题>.md, .meta.json}，front matter（kind/format/gitRemote/gitBranch/gitCommit/instructions，
 *     无 sessionId）、reindexJobId；agent 收到仓库专用 system + instructions + digest；
 *   · text：import:false 只返回不落盘/不重建；import:true 写 originals/input.md；
 *   · 单文件：originals/<原文件名> 复制 + processed/<标题>.md（提取格式 / 非提取格式 .js 兜底）；
 *   · 参数/边界错误：坏集合名、非法 prefix、path+text 冲突、都缺、path 不存在、agent 不可用；
 *   · 截断：maxFiles 警告、maxChars 材料截断提示。
 *
 * 运行（DSH 自带 Node 24）：
 *   & "…\dependencies\node\bin\node.exe" tests\test-structure.mjs
 * 输出：PASS 行 + 末尾「全部通过: N 项」；失败抛错、退出码非 0。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStructureService } from '../plugin/lib/structure.js'

let pass = 0
const ok = (label) => { pass++; console.log('  PASS ' + label) }
const assert = (condition, message) => { if (!condition) throw new Error('ASSERT: ' + message) }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-structure-'))

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

function absOf(root, relTarget) {
  return path.join(root, ...String(relTarget).split('/'))
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

/** 假小代理：记录每次 structure 入参；available=false 模拟「无默认模型」。 */
function createFakeAgent({ body = '# 结构化结果\n\n## 摘要\n\n- fake agent 输出\n', available = true } = {}) {
  const calls = []
  return {
    calls,
    available: () => available,
    route: () => (available ? { provider: 'fake-provider', model: 'fake-model' } : null),
    supportsImages: async () => false,
    async structure(params) {
      calls.push(params)
      return body
    },
    async structureImages() { throw new Error('本测试不涉及图片') },
  }
}

/** 假重建任务管理器（结构与内嵌小代理的 reindex.start({names}) 契约一致）。 */
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

function makeService({ root, agent, reindex, config } = {}) {
  return createStructureService({
    root,
    agent: agent || createFakeAgent(),
    config: config || {},
    reindex: reindex || createFakeReindex(),
    log: () => {},
  })
}

async function expectRejects(promise, label, needle) {
  let error = null
  try { await promise } catch (caught) { error = caught }
  if (error === null) throw new Error('应当被拒绝却成功了：' + label)
  if (needle && !String(error && error.message).includes(needle)) {
    throw new Error(`拒绝原因不符（${label}）：期望包含「${needle}」，实际「${error && error.message}」`)
  }
}

const ROOT = path.join(tmp, 'corpus')

try {
  // -------------------------------------------------------------------------
  // 0) 临时「仓库」夹具：.git/config + HEAD + refs、README、package.json、src/*.js，
  //    外加 node_modules/dist/隐藏目录/二进制文件（都应被扫描跳过）。
  // -------------------------------------------------------------------------
  const repo = path.join(tmp, 'demo-repo')
  const GIT_REMOTE = 'https://github.com/example/demo-repo.git'
  const GIT_COMMIT = '0123456789abcdef0123456789abcdef01234567'
  const readmeText = '# Demo Repo\n\nA tiny fixture repository for structure tests.\n\n## Usage\n\nrun demo\n'
  writeFile(path.join(repo, '.git', 'config'), [
    '[core]',
    '\tbare = false',
    '[remote "origin"]',
    `\turl = ${GIT_REMOTE}`,
    '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    '',
  ].join('\n'))
  writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  writeFile(path.join(repo, '.git', 'refs', 'heads', 'main'), GIT_COMMIT + '\n')
  writeFile(path.join(repo, 'README.md'), readmeText)
  writeFile(path.join(repo, 'package.json'), '{"name":"demo-repo","version":"1.2.3"}\n')
  writeFile(path.join(repo, 'src', 'index.js'), 'export function greet(name) { return `hello ${name}` }\n')
  writeFile(path.join(repo, 'src', 'core.js'), 'export const CORE = 42\n')
  writeFile(path.join(repo, 'docs', 'guide.md'), '# Guide\n\nguide body unique token\n')
  writeFile(path.join(repo, 'node_modules', 'pkg', 'index.js'), 'ignored node module\n')
  writeFile(path.join(repo, 'dist', 'bundle.js'), 'ignored build output\n')
  writeFile(path.join(repo, '.hidden', 'secret.js'), 'hidden secret\n')
  writeFile(path.join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]))
  let symlinkCreated = false
  try {
    fs.symlinkSync(path.join(repo, 'README.md'), path.join(repo, 'linked-readme.md'), 'file')
    symlinkCreated = true
  } catch { /* Windows 普通用户通常建不了符号链接：跳过该断言 */ }
  ok('临时仓库/文件夹具已就绪（.git、README、package.json、src、node_modules/dist/隐藏/二进制' + (symlinkCreated ? '/符号链接' : '') + '）')

  // -------------------------------------------------------------------------
  // 1) 仓库结构化：kind/git/title/stats + 产物布局 + front matter + .meta.json
  // -------------------------------------------------------------------------
  const repoReindex = createFakeReindex()
  const repoAgent = createFakeAgent({
    body: '# Demo Repo 深度解析\n\n> 来源：fixture\n\n## 概览\n\n- 这是一个测试仓库\n\n## 目录与架构\n\n- src/ 核心\n',
  })
  const service = makeService({ root: ROOT, agent: repoAgent, reindex: repoReindex })
  const INSTRUCTIONS = '重点总结架构和数据流'
  const result = await service.run({ path: repo, collection: 'struct-repo', instructions: INSTRUCTIONS })

  assert(result.ok === true && result.imported === true, '仓库导入应 ok/imported：' + JSON.stringify({ ok: result.ok, imported: result.imported }))
  assert(result.kind === 'repo', '目录应识别为 kind=repo，实际 ' + result.kind)
  assert(result.title === 'Demo Repo 深度解析', '标题应取小代理返回正文的 H1，实际 ' + result.title)
  assert(result.collection === 'struct-repo' && result.prefix === '', '返回 collection/prefix')
  assert(result.source === repo, '返回 source 应是仓库绝对路径，实际 ' + result.source)
  assert(result.git && result.git.remote === GIT_REMOTE, 'git.remote 应来自 .git/config，实际 ' + JSON.stringify(result.git))
  assert(result.git.branch === 'main', 'git.branch 应来自 .git/HEAD，实际 ' + result.git.branch)
  assert(result.git.commit === GIT_COMMIT, 'git.commit 应来自 refs/heads/main，实际 ' + result.git.commit)
  assert(result.stats.files === 5, '仓库扫描应只纳入 5 个文本文件（README/package/src×2/docs），实际 ' + result.stats.files)
  assert(result.stats.totalBytes > 0 && result.stats.skipped >= 3, 'stats.totalBytes/skipped（node_modules+dist+logo.png 至少 3），实际 ' + JSON.stringify(result.stats))
  ok('仓库识别：kind=repo、git remote/branch/commit、5 个文本文件、跳过 3+ 个非文本项')

  const parts = String(result.target).split('/')
  assert(parts[0] === 'struct-repo', 'target 应在 <collection>/ 下，实际 ' + result.target)
  assert(/^\d{8}-\d{6}-Demo-Repo-深度解析$/.test(parts[1]), '导入文件夹名应为 <stamp>-<标题slug>，实际 ' + parts[1])
  assert(parts[2] === 'processed' && parts[3] === 'Demo-Repo-深度解析.md', 'target 应指向 processed/<标题slug>.md，实际 ' + result.target)
  assert(fs.existsSync(absOf(ROOT, result.target)), 'processed Markdown 应落盘：' + absOf(ROOT, result.target))
  const folderRel = `struct-repo/${parts[1]}`
  const processed = readFrontMatter(absOf(ROOT, result.target))
  assert(processed.front.title === JSON.stringify('Demo Repo 深度解析'), 'front matter title：' + processed.front.title)
  assert(processed.front.kind === '"repo"' && processed.front.format === '"repository"', 'front matter kind=repo / format=repository')
  assert(processed.front.collection === '"struct-repo"', 'front matter collection')
  assert(processed.front.gitRemote === JSON.stringify(GIT_REMOTE), 'front matter gitRemote')
  assert(processed.front.gitBranch === '"main"' && processed.front.gitCommit === JSON.stringify(GIT_COMMIT), 'front matter gitBranch/gitCommit')
  assert(processed.front.instructions === JSON.stringify(INSTRUCTIONS), 'front matter instructions 应记录额外要求')
  assert(!Object.prototype.hasOwnProperty.call(processed.front, 'sessionId'), '仓库导入的 front matter 不应有 sessionId')
  assert(processed.front.original === undefined, 'front matter 不应有 original')
  assert(processed.body.includes('# Demo Repo 深度解析') && processed.body.includes('## 目录与架构'), '正文应是小代理返回的 Markdown')

  const meta = JSON.parse(fs.readFileSync(absOf(ROOT, `${folderRel}/.meta.json`), 'utf8'))
  for (const key of ['version', 'kind', 'collection', 'folder', 'prefix', 'source', 'processed', 'title', 'format', 'importedAt', 'aiStructured', 'instructions', 'stats', 'git', 'sessionId', 'warnings']) {
    assert(Object.prototype.hasOwnProperty.call(meta, key), '.meta.json 缺字段 ' + key)
  }
  assert(meta.version === 1 && meta.kind === 'repo' && meta.format === 'repository', '.meta.json version/kind/format')
  assert(meta.folder === parts[1] && meta.processed === result.target && meta.original === undefined, '.meta.json folder/processed 且无 original')
  assert(meta.source === repo && meta.title === 'Demo Repo 深度解析' && meta.aiStructured === true, '.meta.json source/title/aiStructured')
  assert(meta.git.remote === GIT_REMOTE && meta.git.branch === 'main' && meta.sessionId === '', '.meta.json git/sessionId')
  assert(!Number.isNaN(Date.parse(meta.importedAt)) && Array.isArray(meta.warnings), '.meta.json importedAt 是 ISO 时间、warnings 是数组')
  assert(!fs.existsSync(absOf(ROOT, `${folderRel}/originals`)), '不应再创建 originals/')
  ok('仓库产物：processed/<标题>.md + .meta.json（不保存原件快照）')

  assert(repoAgent.calls.length === 1, 'agent.structure 应被调用 1 次，实际 ' + repoAgent.calls.length)
  const repoCall = repoAgent.calls[0]
  assert(repoCall.meta && repoCall.meta.format === 'repo' && repoCall.meta.collection === 'struct-repo', 'agent meta.format/collection')
  assert(repoCall.meta.source === repo && repoCall.meta.title === 'demo-repo', 'agent meta.source 是绝对路径、meta.title 用仓库目录名（结构化前）')
  assert(repoCall.instructions === INSTRUCTIONS && repoCall.meta.instructions === INSTRUCTIONS, 'agent 应收到 instructions')
  assert(typeof repoCall.system === 'string' && repoCall.system.includes('仓库分析代理') && repoCall.system.includes('目录与架构'), '仓库应收到专用 system prompt')
  assert(repoCall.maxTokens === 4096, 'agent maxTokens=4096，实际 ' + repoCall.maxTokens)
  assert(repoCall.maxChars >= repoCall.text.length, 'agent maxChars 不应小于材料长度')
  for (const needle of [`Git remote：${GIT_REMOTE}`, 'Git 分支：main', `Git commit：${GIT_COMMIT}`, 'README.md', 'src/index.js', 'Demo Repo']) {
    assert(repoCall.text.includes(needle), 'agent 材料应含 ' + needle)
  }
  ok('仓库入参：仓库专用 system + instructions + digest（Git/README/源码/文件清单）')

  assert(repoReindex.calls.length === 1 && repoReindex.calls[0].names.join(',') === 'struct-repo', '应以 [collection] 触发一次重建，实际 ' + JSON.stringify(repoReindex.calls))
  assert(result.reindexJobId === 'job-fake-1', 'reindexJobId 应来自 reindex.start 的 job.id，实际 ' + result.reindexJobId)
  ok('仓库 reindex：reindex.start({names:[collection]}) + reindexJobId')

  // -------------------------------------------------------------------------
  // 2) text + import:false：只返回结构化结果，不落盘、不触发重建
  // -------------------------------------------------------------------------
  const rootInline = path.join(tmp, 'corpus-inline')
  const inlineAgent = createFakeAgent({ body: '# fake 文本结果\n\n## 摘要\n\n- 不落盘\n' })
  const inlineReindex = createFakeReindex()
  const inlineService = makeService({ root: rootInline, agent: inlineAgent, reindex: inlineReindex })
  const inline = await inlineService.run({ text: '# 网页标题\n\n这是从网页/API 抓来的正文。', collection: '', import: false })
  assert(inline.ok === true && inline.imported === false && inline.kind === 'text', 'import:false 应返回 imported:false / kind:text')
  assert(inline.title === '网页标题', 'text 标题应从正文 H1 推断，实际 ' + inline.title)
  assert(inline.body.includes('# fake 文本结果') && !inline.body.includes('title:'), '返回 body 应是去掉 front matter 的 Markdown')
  assert(inline.target === undefined && inline.original === undefined, 'import:false 不应返回 target/original')
  assert(!fs.existsSync(rootInline), 'import:false 不应创建语料根/写盘')
  assert(inlineReindex.calls.length === 0, 'import:false 不应触发重建')
  assert(inlineAgent.calls.length === 1 && inlineAgent.calls[0].system === undefined, '纯 text 不计仓库/会话，system 应为默认（undefined）')
  ok('text + import:false：只返回结构化结果，不落盘、不重建，system 用默认提示词')

  // -------------------------------------------------------------------------
  // 3) 单文件：originals/<原文件名> 复制 + processed；提取格式与非提取格式兜底
  // -------------------------------------------------------------------------
  const rootFile = path.join(tmp, 'corpus-file')
  const fileAgent = createFakeAgent({ body: '# 文件结构化结果\n\n## 摘要\n\n- 文件\n' })
  const fileReindex = createFakeReindex()
  const fileService = makeService({ root: rootFile, agent: fileAgent, reindex: fileReindex })
  const singlePath = path.join(repo, 'docs', 'guide.md')
  const single = await fileService.run({ path: singlePath, collection: 'struct-file' })
  assert(single.ok === true && single.imported === true && single.kind === 'file', '单文件 kind 应为 file，实际 ' + single.kind)
  assert(single.title === 'Guide', '单文件标题应取提取结果 H1，实际 ' + single.title)
  assert(String(single.target).includes('/processed/Guide.md'), '单文件 target 应为 processed/Guide.md，实际 ' + single.target)
  assert(single.original === undefined, '单文件不再返回 original')
  assert(!fs.existsSync(absOf(rootFile, `${path.dirname(single.target)}/../originals`)), '单文件不应创建 originals/')
  const fileDoc = readFrontMatter(absOf(rootFile, single.target))
  assert(fileDoc.front.kind === '"file"' && fileDoc.front.format === '"file"', '单文件 front matter kind/format=file')
  assert(fileDoc.front.original === undefined, '单文件 front matter 不应有 original')
  const fileCall = fileAgent.calls[0]
  assert(fileCall.system === undefined && fileCall.meta.format === 'file', '单文件不计仓库/会话，system 默认、meta.format=file')
  assert(fileCall.text.includes('格式：md') && fileCall.text.includes('guide body unique token'), '单文件材料应含格式与正文')

  const rawFile = writeFile(path.join(tmp, 'scripts', 'raw.js'), 'const answer = 42\n')
  const raw = await fileService.run({ path: rawFile, collection: 'struct-file' })
  assert(raw.kind === 'file' && raw.title === 'raw', '非提取格式（.js）也应按文本兜底，实际 kind=' + raw.kind + ' title=' + raw.title)
  const rawDoc = readFrontMatter(absOf(rootFile, raw.target))
  assert(rawDoc.front.kind === '"file"' && rawDoc.front.format === '"file"', '.js 单文件 front matter kind/format')
  assert(raw.original === undefined, '.js 单文件不再返回 original')
  assert(fileAgent.calls[1].text.includes('格式：js') && fileAgent.calls[1].text.includes('const answer = 42'), '.js 材料应含「格式：js」与正文')
  assert(fileReindex.calls.length === 2 && fileReindex.calls.every((call) => call.names.join(',') === 'struct-file'), '每次单文件导入都应触发重建')
  ok('单文件：只写 processed/<标题>.md（.md 提取 / .js 文本兜底），不保存原件 + 重建')

  // -------------------------------------------------------------------------
  // 4) text 导入：originals/input.md 原文快照 + front matter + 重建
  // -------------------------------------------------------------------------
  const rootText = path.join(tmp, 'corpus-text')
  const textAgent = createFakeAgent({ body: '# 文本结构化\n\n## 摘要\n\n- text 导入\n' })
  const textReindex = createFakeReindex()
  const textService = makeService({ root: rootText, agent: textAgent, reindex: textReindex })
  const sourceText = '# API 说明\n\n{"ok":true}\n'
  const textImport = await textService.run({ text: sourceText, collection: 'struct-text', instructions: '保留接口名' })
  assert(textImport.ok === true && textImport.imported === true && textImport.kind === 'text', 'text 导入 kind=text')
  assert(textImport.title === 'API 说明', 'text 导入标题应取 H1，实际 ' + textImport.title)
  assert(textImport.original === undefined, 'text 导入不再保存原件')
  const textDoc = readFrontMatter(absOf(rootText, textImport.target))
  assert(textDoc.front.kind === '"text"' && textDoc.front.format === '"text"', 'text 导入 front matter kind/format=text')
  assert(textDoc.front.instructions === JSON.stringify('保留接口名'), 'text 导入 front matter instructions')
  assert(!Object.prototype.hasOwnProperty.call(textDoc.front, 'gitRemote'), 'text 导入不应有 gitRemote')
  assert(textReindex.calls.length === 1 && textImport.reindexJobId === 'job-fake-1', 'text 导入后触发重建并返回 reindexJobId')
  const prefixed = await textService.run({ text: '# 带 prefix\n\nprefix body\n', collection: 'struct-text', prefix: 'notes/2026' })
  assert(String(prefixed.target).startsWith('struct-text/notes/2026/'), 'prefix 应写入 <collection>/<prefix>/ 下，实际 ' + prefixed.target)
  assert(fs.existsSync(absOf(rootText, prefixed.target)) && String(prefixed.target).startsWith('struct-text/notes/2026/'), 'prefix 的 processed 路径')
  assert(textReindex.calls.length === 2, '每次导入都应触发一次重建，实际 ' + textReindex.calls.length)
  ok('text 导入：processed + front matter + prefix + 重建，不保存原件')

  // -------------------------------------------------------------------------
  // 5) 参数与边界错误
  // -------------------------------------------------------------------------
  await expectRejects(service.run({ text: 'x', collection: 'bad name!' }), '坏集合名（import）', 'collection 必须是合法集合名')
  await expectRejects(service.run({ text: 'x', collection: 'bad/name', import: false }), '坏集合名（只总结）', 'collection 必须是合法集合名')
  await expectRejects(service.run({ text: 'x', collection: 'struct-repo', prefix: 'a/../b' }), '非法 prefix', 'prefix 不能包含 . 或 ..')
  await expectRejects(service.run({ path: repo, text: 'x', collection: 'struct-repo' }), 'path+text 冲突', 'path 与 text 只能二选一')
  await expectRejects(service.run({ collection: 'struct-repo' }), '缺 path/text', '必须提供 path 或 text 之一')
  await expectRejects(service.run({ path: path.join(tmp, 'no-such-dir'), collection: 'struct-repo' }), 'path 不存在', 'path 不存在')
  const unavailableService = makeService({
    root: ROOT,
    agent: createFakeAgent({ available: false }),
    reindex: createFakeReindex(),
  })
  await expectRejects(unavailableService.run({ text: '# x\n', collection: 'struct-repo' }), 'agent 不可用', '内置小代理不可用')
  ok('参数/边界错误：坏集合名 ×2、非法 prefix、path+text 冲突、都缺、path 不存在、agent 不可用')

  // -------------------------------------------------------------------------
  // 6) 仓库截断：maxFiles 警告 + maxChars 材料截断提示
  // -------------------------------------------------------------------------
  const repoMany = path.join(tmp, 'many-files')
  writeFile(path.join(repoMany, 'README.md'), '# Many Files\n\nfixture\n')
  writeFile(path.join(repoMany, 'package.json'), '{"name":"many-files"}\n')
  for (let index = 0; index < 10; index += 1) {
    writeFile(path.join(repoMany, 'src', `f${index}.js`), `export const v${index} = ${index}\n`)
  }
  const manyAgent = createFakeAgent()
  const manyService = makeService({ root: path.join(tmp, 'corpus-many'), agent: manyAgent })
  const many = await manyService.run({ path: repoMany, collection: 'struct-many', maxFiles: 3 })
  assert(many.stats.files === 12, 'many-files 仓库应扫描 12 个文件，实际 ' + many.stats.files)
  assert(many.stats.included === 3, 'maxFiles=3 时材料应只读入 3 个文件，实际 ' + many.stats.included)
  assert(many.warnings.some((warning) => warning.includes('maxFiles=3')), '应给出 maxFiles 截断警告，实际 ' + JSON.stringify(many.warnings))
  assert(many.warnings.some((warning) => warning.includes('实际读入 3 个')), '应给出「实际读入 N 个」警告，实际 ' + JSON.stringify(many.warnings))

  const repoBig = path.join(tmp, 'big-list')
  for (let index = 0; index < 260; index += 1) {
    writeFile(path.join(repoBig, 'many', `file${String(index).padStart(3, '0')}.js`), `export const n = ${index}\n`)
  }
  const bigAgent = createFakeAgent()
  const bigService = makeService({ root: path.join(tmp, 'corpus-big'), agent: bigAgent, config: { structureMaxChars: 4000 } })
  const big = await bigService.run({ path: repoBig, collection: 'struct-big' })
  assert(big.stats.files === 260, 'big-list 仓库应扫描 260 个文件，实际 ' + big.stats.files)
  assert(big.warnings.some((warning) => warning.includes('maxFiles/maxChars')), '应给出受 maxFiles/maxChars 限制的警告，实际 ' + JSON.stringify(big.warnings))
  assert(bigAgent.calls[0].text.includes('已截断到前 4000 字'), 'digest 超过 maxChars 时应带材料截断提示')
  assert(bigAgent.calls[0].maxChars >= 8000, '材料截断提示后 agent maxChars 应相应放宽，实际 ' + bigAgent.calls[0].maxChars)
  ok('仓库截断：maxFiles 警告 + maxChars 材料截断提示（260 文件 / 4000 字上限）')

  console.log('\n全部通过: ' + pass + ' 项（v1.4 仓库/内容结构化）')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
