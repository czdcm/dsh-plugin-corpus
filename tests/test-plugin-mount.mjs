// dsh-plugin-corpus v1.5 — 插件入口集成测试（Cordis 桩）。
//
// 目的：验证 plugin/lib/index.js 的 apply() 真的能把 10 个工具、systemPrompt 注入、
// webServer 19 条路由挂起来，并用临时语料跑通「自动建索引 → 检索 → 读取 → 导入 → 异步重建
// → corpus_ingest 摄取 → v1.4 corpus_structure / corpus_summarize_session 主会话接口
// → v1.5 /settings 根目录 API」的工具闭环。
// 不依赖 DSH 运行时：把 lib/ 复制到临时目录，在它的 node_modules 下放
// @deepseek-ai/schemastery 与 @deepseek-ai/dsh-tools 的最小桩，再用假 ctx 调 apply；
// 假 ctx 带 sessions 服务（供 /access 与 corpus_summarize_session 用）和一个 fake llm.stream
// （只回固定 Markdown，不调用真实模型）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

let pass = 0
const ok = (label) => { pass++; console.log('  PASS ' + label) }
const assert = (condition, message) => { if (!condition) throw new Error('ASSERT: ' + message) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-mount-'))

function writeStub(packageName, source) {
  const dir = path.join(temp, 'node_modules', '@deepseek-ai', packageName)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: `@deepseek-ai/${packageName}`,
    type: 'module',
    exports: { '.': './index.js' },
  }))
  fs.writeFileSync(path.join(dir, 'index.js'), source)
}

function makeCtx(home, dir, sessions, llm) {
  const tools = new Map()
  const routes = []
  const promptContexts = []
  const effects = []
  const scopeOf = (name) => {
    if (name === 'systemPrompt') {
      return {
        systemPrompt: {
          context(options) { promptContexts.push(options); return () => {} },
        },
        effect(fn) { effects.push(fn()); },
      }
    }
    if (name === 'webServer') {
      return {
        webServer: {
          register(route) { routes.push(route); return () => {} },
        },
        effect(fn) { effects.push(fn()); },
      }
    }
    return { effect(fn) { effects.push(fn()); } }
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'profileContext') return { home, dir }
      if (name === 'sessions') return sessions || undefined
      if (name === 'llm') return llm || undefined
      return undefined
    },
    tools: { register(tool) { tools.set(tool.name, tool); return () => {} } },
    inject(names, callback) {
      for (const name of names) callback(scopeOf(name))
    },
    effect(fn) { effects.push(fn()); return () => {} },
  }
  return { ctx, tools, routes, promptContexts, effects }
}

/** 假 llm：只实现 stream({system,messages,...}) 返回固定的 text-delta + finish（不调真实模型）。 */
function createFakeLlm() {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      const index = calls.length
      const title = index === 1 ? '集成结构化结果' : '会话总结结构化结果'
      return (async function* chunks() {
        yield { type: 'text-delta', text: `# ${title}\n\n## 概览\n\n- fake llm 输出 ${index}\n` }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

try {
  // 1) 复制插件 lib，准备桩与临时语料
  const libSource = path.join(projectRoot, 'plugin', 'lib')
  const libDir = path.join(temp, 'lib')
  fs.cpSync(libSource, libDir, { recursive: true })
  fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ name: 'corpus-mount-test', type: 'module' }))
  writeStub('schemastery', `
    function chain() {
      const api = {
        default(value) { api._default = value; return api },
        min() { return api },
        max() { return api },
        required() { return api },
      }
      return api
    }
    const Schema = {
      object(shape) { return { shape, default() { return this }, _default: {} } },
      string() { return chain() },
      number() { return chain() },
      boolean() { return chain() },
    }
    export default Schema
  `)
  writeStub('dsh-tools', `export function defineTool(definition) { return definition }`)

  const home = path.join(temp, 'home')
  const root = path.join(temp, 'corpus')
  const workspace = path.join(temp, 'workspace')
  fs.mkdirSync(path.join(root, 'alpha'), { recursive: true })
  fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(root, 'alpha', 'a.md'), '# Alpha A\n\nhello corpus world\nsecond line\n')
  fs.writeFileSync(path.join(root, 'alpha', 'b.md'), '# Alpha B\n\nanother document\n')
  fs.writeFileSync(path.join(workspace, 'docs', 'imported.md'), '# Imported\n\nimported by mount test\n')
  fs.writeFileSync(path.join(workspace, 'docs', 'ingested.md'), '# Ingested\n\ningested by mount test corpus_ingest\n')
  fs.writeFileSync(path.join(home, 'corpus-access.json'), JSON.stringify({
    version: 1,
    default: 'deny',
    grants: [{ workspace, paths: ['alpha'] }],
    deny: [],
  }))
  ok('临时语料 / 桩 / 策略已就绪')

  // 2) apply 插件（fake ctx 带 sessions 服务 + fake llm；sessions 供 /access 与 corpus_summarize_session 用）
  const { apply } = await import(pathToFileURL(path.join(libDir, 'index.js')).href + '?t=' + Date.now())
  const sessionMount = {
    id: 'session-mount',
    header: { cwd: workspace },
    deriveMessages() {
      return [
        { role: 'user', content: [{ type: 'text', text: '请把这次 mount 测试总结进语料' }], source: { kind: 'user' } },
        { role: 'assistant', content: [{ type: 'text', text: '已完成 10 个工具与 19 条路由的挂载验证' }] },
      ]
    },
  }
  const sessions = {
    get(id) { return id === 'session-mount' ? sessionMount : undefined },
    list() { return [{ id: 'session-mount', workspace }] },
  }
  const fakeLlm = createFakeLlm()
  const fake = makeCtx(home, path.join(temp, 'profile'), sessions, fakeLlm)
  const disposer = apply(fake.ctx, { corpusRoot: root, promptOrder: 9000, maxPromptFiles: 12 })
  assert(typeof disposer === 'function', 'apply 返回 disposer')
  assert(fake.tools.size === 11, '注册 11 个工具，实际 ' + fake.tools.size)
  for (const name of ['corpus_search', 'corpus_read', 'corpus_list', 'corpus_reindex', 'corpus_status', 'corpus_import', 'corpus_ingest', 'corpus_access', 'corpus_structure', 'corpus_summarize_session', 'corpus_delete']) {
    assert(fake.tools.has(name), '缺少工具 ' + name)
  }
  ok('apply 注册 11 个工具（v1.3 的 8 + v1.4 的 corpus_structure / corpus_summarize_session）')

  assert(fake.routes.length === 19, '注册 19 条面板路由，实际 ' + fake.routes.length)
  assert(fake.routes.every((route) => route.kind === 'exact' && route.path.startsWith('/api/dsh-plugin-corpus/')), '面板路由形状')
  for (const suffix of ['access', 'import/targets', 'import', 'import/status', 'openers', 'app-icon', 'settings', 'settings/root', 'settings/open', 'gallery', 'delete']) {
    assert(fake.routes.some((route) => route.path === '/api/dsh-plugin-corpus/' + suffix), '缺少路由 ' + suffix)
  }
  ok('apply 挂载 19 条 /api/dsh-plugin-corpus 路由（含 /access、v1.3 /import/*）')

  const invokePanel = (method, url, body, headers = {}) => new Promise((resolve, reject) => {
    const route = fake.routes.find((item) => item.path === url.split('?')[0])
    if (!route) return reject(new Error('没有路由 ' + url))
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    req.method = method
    req.url = url
    req.headers = { host: '127.0.0.1:9', ...headers }
    const res = {
      statusCode: 0,
      setHeader() {},
      end(text) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }) },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
  const accessRoute = await invokePanel('GET', '/api/dsh-plugin-corpus/access?session=session-mount')
  assert(accessRoute.status === 200 && accessRoute.body.ok === true, '/access 200：' + JSON.stringify(accessRoute.body))
  assert(accessRoute.body.sessionId === 'session-mount' && accessRoute.body.workspace === workspace, '/access 通过 ctx.sessions 解析 workspace')
  assert(accessRoute.body.effectiveCollections.join(',') === 'alpha', '/access effectiveCollections 受 ACL 限制')
  assert(accessRoute.body.policy.grants.length === 1, '/access 带策略摘要')
  ok('apply 的 /access 路由用 ctx.sessions 解析会话工作区')

  const targetsRes = await invokePanel('GET', '/api/dsh-plugin-corpus/import/targets')
  assert(targetsRes.status === 200 && targetsRes.body.ok === true, '/import/targets 200：' + JSON.stringify(targetsRes.body))
  assert(Array.isArray(targetsRes.body.collections) && targetsRes.body.collections.some((item) => item.name === 'alpha'), '/import/targets 带集合候选')
  assert(Array.isArray(targetsRes.body.formats) && targetsRes.body.formats.length === 19 && targetsRes.body.formats.includes('.pdf') && targetsRes.body.formats.includes('.gif'), '/import/targets formats（19 种）')
  for (const key of ['pdf', 'office', 'officecli', 'html', 'bundle', 'ocr', 'image']) {
    assert(typeof targetsRes.body.extractors[key] === 'boolean', '/import/targets extractors.' + key)
  }
  assert(targetsRes.body.aiAvailable === true, 'fake llm 可用时 aiAvailable 应为 true')
  assert(targetsRes.body.visionAvailable === false, '假 ctx 无 attachments，visionAvailable 应为 false')
  assert(targetsRes.body.limits.maxFiles === 200 && targetsRes.body.limits.maxUploadBytes === 25 * 1024 * 1024, '/import/targets 默认 limits')
  ok('apply 的 /import/targets 返回 formats / extractors{7} / ai·vision 可用性 / limits')

  assert(fake.promptContexts.length === 1 && fake.promptContexts[0].name === 'corpus.index', 'systemPrompt.context')
  ok('apply 注入 systemPrompt 上下文')

  // 3) 工具闭环
  const exec = { agent: { session: sessionMount } }
  const call = async (name, args) => {
    const tool = fake.tools.get(name)
    return JSON.parse(await tool.execute(args || {}, exec))
  }
  const waitIdle = async (timeoutMs = 30000) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const status = await call('corpus_status', {})
      if (status.active === null) return status
      await sleep(120)
    }
    throw new Error('等待重建超时')
  }
  const waitIngestDone = async (timeoutMs = 30000) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const status = await call('corpus_status', {})
      const ingest = status.ingest || {}
      if (ingest.active === null && Array.isArray(ingest.recent) && ingest.recent.length > 0) return ingest.recent[0]
      await sleep(120)
    }
    throw new Error('等待导入任务超时')
  }

  const listed = await call('corpus_list', {})
  assert(listed.ok === true && listed.collections.length === 1 && listed.collections[0].name === 'alpha', 'corpus_list 只列授权集合')
  ok('corpus_list 受 ACL 限制')

  const access = await call('corpus_access', {})
  assert(access.ok === true && access.collections.join(',') === 'alpha'
    && access.workspace === workspace.replace(/\\/g, '/').toLowerCase(), 'corpus_access')
  ok('corpus_access 返回工作区与集合')

  const firstSearch = await call('corpus_search', { query: 'hello' })
  assert(firstSearch.ok === false && firstSearch.building === true, '首次检索应触发后台建索引: ' + JSON.stringify(firstSearch))
  ok('空索引检索会启动后台重建')

  const afterBuild = await waitIdle()
  assert(afterBuild.active === null && Array.isArray(afterBuild.collections) && afterBuild.collections[0].docs === 2, '重建完成')
  const found = await call('corpus_search', { query: 'hello' })
  assert(found.ok === true && found.hits.length > 0 && found.hits[0].path.startsWith('alpha/'), '检索命中')
  ok('建索引后 corpus_search 命中')

  const read = await call('corpus_read', { path: found.hits[0].path, from: 1, lines: 3 })
  assert(read.ok === true && read.text.includes('hello'), 'corpus_read')
  ok('corpus_read 按行读取')

  const imported = await call('corpus_import', { path: 'docs/imported.md', collection: 'alpha' })
  assert(imported.ok === true && imported.imported === 1 && imported.jobId !== null, 'corpus_import')
  await waitIdle()
  const foundImported = await call('corpus_search', { query: 'imported by mount' })
  assert(foundImported.ok === true && foundImported.hits.some((hit) => hit.path === 'alpha/imported.md'), '导入后可检索')
  ok('corpus_import 相对工作区导入 + 自动重建 + 可检索')

  let denied = false
  try { await call('corpus_import', { path: 'docs/imported.md', collection: 'beta' }) } catch (error) {
    denied = String(error && error.message).includes('权限')
  }
  assert(denied, '未授权集合应拒绝导入')
  ok('corpus_import 拒绝未授权集合')

  const reindex = await call('corpus_reindex', { collection: 'alpha', force: true })
  assert(reindex.ok === true && reindex.started === true && typeof reindex.jobId === 'string', 'corpus_reindex 异步启动')
  const second = await call('corpus_reindex', { collection: 'alpha' })
  assert(second.ok === false && second.busy === true && second.job && second.job.id === reindex.jobId, '同进程 busy 形态')
  await waitIdle()
  ok('corpus_reindex 异步 + busy 形态')

  // v1.3：corpus_ingest 启动后台导入任务（显式 ai:false → 确定性 Markdown，不调模型），
  // 任务完成后自动触发该集合重建。
  const ingested = await call('corpus_ingest', { path: 'docs/ingested.md', collection: 'alpha', ai: false })
  assert(ingested.ok === true && ingested.started === true && typeof ingested.jobId === 'string', 'corpus_ingest 应返回 jobId：' + JSON.stringify(ingested))
  const ingestJob = await waitIngestDone()
  assert(ingestJob.id === ingested.jobId && ingestJob.state === 'done' && ingestJob.done === 1 && ingestJob.failed === 0, 'corpus_ingest 任务应 done（1/1）：' + JSON.stringify(ingestJob))
  assert(Array.isArray(ingestJob.items) && ingestJob.items[0].ok === true && ingestJob.items[0].aiStructured === false, 'corpus_ingest item：成功 + 无 AI 时 aiStructured=false')
  // 每条导入一个文件夹，items[].target → processed/，不保存原件。
  const ingestItem = ingestJob.items[0]
  assert(String(ingestItem.target).includes('/processed/') && ingestItem.original === undefined, 'corpus_ingest item 只应指向 processed/：' + JSON.stringify(ingestItem))
  assert(fs.existsSync(path.join(root, ...ingestItem.target.split('/'))), 'processed Markdown 应落盘')
  assert(!fs.existsSync(path.join(root, 'alpha', ingestItem.folder, 'originals')), '不应创建 originals/')
  assert(fs.existsSync(path.join(root, 'alpha', ingestItem.folder, '.meta.json')), '导入文件夹应有 .meta.json')
  ok('corpus_ingest 布局：每导入一文件夹（processed/ + .meta.json，不保存源文件）')
  await waitIdle()
  ok('corpus_ingest：相对工作区导入 → 后台任务 running→done → 自动重建')

  let ingestDenied = false
  try { await call('corpus_ingest', { path: 'docs/ingested.md', collection: 'beta' }) } catch (error) {
    ingestDenied = String(error && error.message).includes('权限')
  }
  assert(ingestDenied, 'corpus_ingest 未授权集合应拒绝')
  ok('corpus_ingest 拒绝未授权集合')

  // v1.4：主会话交流接口 —— corpus_structure 同步把文件结构化进语料库
  const structured = await call('corpus_structure', { path: 'docs/imported.md', collection: 'alpha', instructions: '重点总结架构' })
  assert(structured.ok === true && structured.imported === true && structured.kind === 'file', 'corpus_structure 应同步导入文件：' + JSON.stringify(structured))
  assert(typeof structured.target === 'string' && structured.target.includes('/processed/'), 'corpus_structure 应返回 processed target：' + structured.target)
  assert(fs.existsSync(path.join(root, ...structured.target.split('/'))), 'corpus_structure processed Markdown 应落盘')
  assert(structured.original === undefined, 'corpus_structure 不再保存原件：' + structured.original)
  assert(typeof structured.reindexJobId === 'string' && structured.reindexJobId !== '', 'corpus_structure 应触发重建并返回 reindexJobId')
  assert(String(structured.body).includes('# 集成结构化结果'), 'corpus_structure 应同步返回结构化 Markdown body')
  await waitIdle()
  const foundStructured = await call('corpus_search', { query: '集成结构化结果' })
  assert(foundStructured.ok === true && foundStructured.hits.some((hit) => hit.path === structured.target), 'corpus_structure 写入的内容重建后可检索：' + JSON.stringify(foundStructured.hits || []))
  ok('corpus_structure：同步结构化 → processed → 自动重建 → 可检索（不保存原件）')

  // v1.4：corpus_summarize_session 读取当前会话公开投影并落盘
  const summarized = await call('corpus_summarize_session', { collection: 'alpha', instructions: '保留测试输出' })
  assert(summarized.ok === true && summarized.imported === true && summarized.kind === 'session', 'corpus_summarize_session 应导入会话总结：' + JSON.stringify(summarized))
  assert(summarized.sessionId === 'session-mount', '会话总结应记录当前会话 id')
  assert(summarized.transcript && summarized.transcript.included === 2, 'transcript 统计应纳入 2 条可见消息，实际 ' + JSON.stringify(summarized.transcript))
  assert(summarized.original === undefined, '会话总结不再保存原件：' + summarized.original)
  assert(fs.readFileSync(path.join(root, ...String(summarized.target).split('/')), 'utf8').includes('sessionId: "session-mount"'), '会话总结 front matter 应含 sessionId')
  assert(typeof summarized.reindexJobId === 'string' && summarized.reindexJobId !== '', '会话总结应触发重建并返回 reindexJobId')
  await waitIdle()
  ok('corpus_summarize_session：会话投影 → processed + 自动重建（不保存原件）')

  assert(fakeLlm.calls.length === 2, '两个 v1.4 工具各应调用一次内置小代理，实际 ' + fakeLlm.calls.length)
  assert(String(fakeLlm.calls[0].system || '').includes('语料摄取小代理'), 'corpus_structure（单文件）用默认摄取 system prompt')
  assert(String(fakeLlm.calls[1].system || '').includes('会话总结代理'), 'corpus_summarize_session 用会话总结专用 system prompt')
  assert(Array.isArray(fakeLlm.calls[1].messages) && fakeLlm.calls[1].messages[0].content.some((block) => block.type === 'text' && block.text.includes('DSH 会话记录')), '会话总结应把 transcript 交给模型')
  ok('v1.4：两个新工具都走内置小代理（默认摄取 / 会话总结专用 system prompt）')

  const prompt = fake.promptContexts[0].text({ agent: exec.agent })
  assert(typeof prompt === 'string' && prompt.includes('alpha') && prompt.includes('corpus_status') && prompt.includes('corpus_import'), 'prompt 文本')
  assert(prompt.includes('corpus_structure') && prompt.includes('corpus_summarize_session'), 'systemPrompt 应含 v1.4 两个新工具的约定')
  assert(prompt.includes('git clone/pull') || prompt.includes('clone/pull'), 'systemPrompt 应提示仓库先 clone/pull 再 corpus_structure')
  ok('systemPrompt 文本含授权集合 + v1.4 两个新工具约定')

  disposer()
  console.log('\n全部通过: ' + pass + ' 项（插件入口集成）')
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
