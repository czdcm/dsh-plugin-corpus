/**
 * dsh-plugin-corpus v1.4 — 会话转录（plugin/lib/session-transcript.js）与会话总结落盘
 * （structure.js 的 kind:'session' 分支）验收测试（新）。
 *
 * 自包含：在 os.tmpdir() 下造临时语料根；用 fake session（只有 deriveMessages() 的公开投影）、
 * fake agent（记录入参、返回 Markdown）与 fake reindex，**不调用真实模型、不碰 ~/.dsh、不改任何会话**。
 *
 * 覆盖：
 *   · buildSessionTranscript：只纳入人类 user（source.kind 缺省/user）、assistant 可见文本与
 *     tool-call（名 + 参数）、tool result；跳过 system/developer、注入上下文（source.kind≠user）、
 *     reasoning 块、纯推理消息、空消息、图片/文件转占位符；
 *   · 标题头/统计（messages/included/toolResults/skipped/injected/chars）与 warnings；
 *   · maxMessages / perMessageChars / toolResultChars / maxChars 的截断与警告；
 *   · 不可读 session / 空会话报错；
 *   · structure.run({kind:'session'})：originals/session-transcript.md 原文快照 +
 *     processed/<标题>.md + front matter（kind=session、sessionId、instructions，无 git）+ .meta.json +
 *     会话专用 system prompt + reindex；不传 title 时默认「会话总结 日期」。
 *
 * 运行（DSH 自带 Node 24）：
 *   & "…\dependencies\node\bin\node.exe" tests\test-session-transcript.mjs
 * 输出：PASS 行 + 末尾「全部通过: N 项」；失败抛错、退出码非 0。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildSessionTranscript } from '../plugin/lib/session-transcript.js'
import { createStructureService } from '../plugin/lib/structure.js'

let pass = 0
const ok = (label) => { pass++; console.log('  PASS ' + label) }
const assert = (condition, message) => { if (!condition) throw new Error('ASSERT: ' + message) }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-session-'))

function makeSession(id, messages) {
  return { id, deriveMessages: () => messages }
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

function absOf(root, relTarget) {
  return path.join(root, ...String(relTarget).split('/'))
}

function countOccurrences(text, needle) {
  return String(text).split(needle).length - 1
}

function expectThrows(fn, label, needle) {
  let error = null
  try { fn() } catch (caught) { error = caught }
  if (error === null) throw new Error('应当被拒绝却成功了：' + label)
  if (needle && !String(error && error.message).includes(needle)) {
    throw new Error(`报错原因不符（${label}）：期望包含「${needle}」，实际「${error && error.message}」`)
  }
}

/** 假小代理：记录 structure 入参；返回固定 Markdown。 */
function createFakeAgent({ body = '# 会话总结结果\n\n## 会话目标与背景\n\n- fake agent\n' } = {}) {
  const calls = []
  return {
    calls,
    available: () => true,
    route: () => ({ provider: 'fake-provider', model: 'fake-model' }),
    supportsImages: async () => false,
    async structure(params) { calls.push(params); return body },
    async structureImages() { throw new Error('本测试不涉及图片') },
  }
}

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

try {
  // -------------------------------------------------------------------------
  // 0) 公开投影夹具：人类/注入 user、assistant 可见文本 + reasoning + tool-call、
  //    tool result、system、纯推理、空消息、图片块。
  // -------------------------------------------------------------------------
  const messages = [
    { role: 'system', content: '系统注入内容（不应出现）' },
    { role: 'user', content: [{ type: 'text', text: '人类第一条需求' }], source: { kind: 'user' } },
    { role: 'user', content: [{ type: 'text', text: '<注入的开发上下文>' }], source: { kind: 'injection' } },
    { role: 'user', content: '没有 source 的人类消息' },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '内部推理不应出现' },
        { type: 'text', text: '助手可见回复' },
        { type: 'tool-call', id: 'call-1', name: 'corpus_search', arguments: { query: 'alpha' } },
      ],
    },
    { role: 'assistant', content: [{ type: 'reasoning', text: '只有推理' }] },
    { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: '工具结果内容 alpha' }] },
    { role: 'user', content: '   ' },
    { role: 'assistant', content: [{ type: 'image', mediaType: 'image/png' }, { type: 'text', text: '图片说明' }] },
  ]
  const session = makeSession('session-alpha', messages)
  const built = buildSessionTranscript(session)
  assert(typeof built.text === 'string' && built.text.length > 0, '应返回 transcript 文本')
  assert(built.stats.messages === 9, 'stats.messages=9，实际 ' + built.stats.messages)
  assert(built.stats.included === 4, 'stats.included=4（2 条 user + 2 条 assistant），实际 ' + built.stats.included)
  assert(built.stats.toolResults === 1, 'stats.toolResults=1，实际 ' + built.stats.toolResults)
  assert(built.stats.skipped === 4, 'stats.skipped=4（system/注入/纯推理/空消息），实际 ' + built.stats.skipped)
  assert(built.stats.injected === 1, 'stats.injected=1，实际 ' + built.stats.injected)
  assert(built.stats.chars === built.text.length, 'stats.chars 应等于文本长度')
  assert(built.warnings.length === 0, '默认参数不应有 warning，实际 ' + JSON.stringify(built.warnings))
  ok('会话投影统计：9 条消息 → 纳入 5（user/assistant 4 + 工具结果 1）、跳过 4、注入 1')

  assert(built.text.includes('# DSH 会话记录'), '应有 transcript 标题')
  assert(built.text.includes('- 会话 id：session-alpha'), '应记录会话 id')
  assert(built.text.includes('- 原始消息数：9'), '应记录原始消息数')
  assert(built.text.includes('- 纳入消息数：5（用户/助手 4，工具结果 1）'), '应记录纳入消息数：' + built.text.split('\n').slice(0, 8).join(' / '))
  assert(built.text.includes('- 跳过消息数：4（其中注入上下文 1）'), '应记录跳过消息数（含注入）')
  ok('会话转录标题头：会话 id / 原始·纳入·跳过消息数（含注入计数）')

  for (const needle of ['人类第一条需求', '没有 source 的人类消息', '助手可见回复', '工具结果内容 alpha', '图片说明', '[图片]']) {
    assert(built.text.includes(needle), 'transcript 应包含 ' + needle)
  }
  assert(built.text.includes('[调用工具 corpus_search {"query":"alpha"}]'), 'tool-call 应带工具名与参数')
  assert(built.text.includes('### 工具结果（corpus_search）'), '工具结果标题应带工具名')
  for (const hidden of ['系统注入内容', '<注入的开发上下文>', '内部推理不应出现', '只有推理']) {
    assert(!built.text.includes(hidden), 'transcript 不应包含 ' + hidden)
  }
  ok('会话投影内容：人类 user / 助手可见文本 / tool-call / tool result；跳过 system·注入·reasoning')

  // -------------------------------------------------------------------------
  // 1) tool-call 参数为字符串、工具结果找不到调用（标题不带工具名）、角色非 user/assistant/tool
  // -------------------------------------------------------------------------
  const stringArgs = [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call-2', name: 'corpus_read', arguments: '{"path":"alpha/a.md","lines":2}' }] },
    { role: 'tool', toolCallId: 'call-2', content: '工具原始结果文本' },
    { role: 'tool', toolCallId: 'call-unknown', content: [{ type: 'text', text: '未匹配调用的结果' }] },
    { role: 'developer', content: 'developer 注入' },
  ]
  const built2 = buildSessionTranscript(makeSession('session-args', stringArgs))
  assert(built2.stats.included === 1 && built2.stats.toolResults === 2, '字符串参数消息应纳入 1 条助手 + 2 条工具结果，实际 ' + JSON.stringify(built2.stats))
  assert(built2.text.includes('[调用工具 corpus_read {"path":"alpha/a.md","lines":2}]'), '字符串形式的参数应原样保留')
  assert(built2.text.includes('### 工具结果（corpus_read）') && built2.text.includes('### 工具结果\n\n未匹配调用的结果'), '匹配不到调用时工具结果标题应退化为「工具结果」')
  assert(!built2.text.includes('developer 注入'), 'developer 消息不应纳入')
  ok('tool-call 字符串参数 / 工具结果匹配不到调用 / developer 角色')

  // -------------------------------------------------------------------------
  // 2) maxMessages：只处理前 N 条并给 warning
  // -------------------------------------------------------------------------
  const many = makeSession('session-many', Array.from({ length: 5 }, (_item, index) => (
    { role: 'user', content: `第 ${index + 1} 条用户消息` }
  )))
  const limited = buildSessionTranscript(many, { maxMessages: 2 })
  assert(countOccurrences(limited.text, '### 用户') === 2, 'maxMessages=2 时应只渲染 2 条用户消息，实际 ' + countOccurrences(limited.text, '### 用户'))
  assert(limited.warnings.some((warning) => warning.includes('maxMessages=2')), '应给出 maxMessages 警告，实际 ' + JSON.stringify(limited.warnings))
  assert(!limited.text.includes('第 3 条用户消息'), '超过 maxMessages 的消息不应出现')
  ok('maxMessages：只处理前 2 条并给截断警告')

  // -------------------------------------------------------------------------
  // 3) perMessageChars / toolResultChars：单条截断并注明
  // -------------------------------------------------------------------------
  const longText = 'x'.repeat(1200)
  const longResult = 'y'.repeat(1000)
  const clipped = buildSessionTranscript(makeSession('session-clip', [
    { role: 'user', content: longText },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call-3', name: 'corpus_list', arguments: {} }] },
    { role: 'tool', toolCallId: 'call-3', content: [{ type: 'text', text: longResult }] },
  ]), { perMessageChars: 500, toolResultChars: 200 })
  assert(clipped.text.includes('…[已截断 700 字]'), '用户消息应按 perMessageChars=500 截断并注明 700 字')
  assert(clipped.text.includes('…[已截断 800 字]'), '工具结果应按 toolResultChars=200 截断并注明 800 字')
  ok('perMessageChars / toolResultChars：单条截断并注明省略字数')

  // -------------------------------------------------------------------------
  // 4) maxChars：整篇 transcript 截断并给 warning
  // -------------------------------------------------------------------------
  const huge = makeSession('session-huge', Array.from({ length: 3 }, (_item, index) => (
    { role: 'user', content: `长消息 ${index + 1} ` + 'z'.repeat(3000) }
  )))
  const truncated = buildSessionTranscript(huge, { maxChars: 4000 })
  assert(truncated.warnings.some((warning) => warning.includes('maxChars=4000')), '应给出 maxChars 警告，实际 ' + JSON.stringify(truncated.warnings))
  assert(truncated.text.includes('[会话记录共') && truncated.text.includes('已截断到前 4000 字'), '正文应带整篇截断提示')
  assert(truncated.text.length > 4000, '截断后的 transcript 仍应包含提示文本')
  ok('maxChars：整篇 transcript 截断（前 4000 字 + 提示）并给 warning')

  // -------------------------------------------------------------------------
  // 5) 不可读 session / 空会话
  // -------------------------------------------------------------------------
  expectThrows(() => buildSessionTranscript(null), 'null session', 'Session.deriveMessages 不可用')
  expectThrows(() => buildSessionTranscript({ id: 'no-derive' }), '缺少 deriveMessages', 'Session.deriveMessages 不可用')
  expectThrows(() => buildSessionTranscript(makeSession('empty', [])), '空会话', '当前会话还没有消息')
  ok('错误路径：null/缺 deriveMessages/空会话都给出明确报错')

  // -------------------------------------------------------------------------
  // 6) structure.run({kind:'session'})：originals/session-transcript.md + processed + front matter
  // -------------------------------------------------------------------------
  const root = path.join(tmp, 'corpus')
  const agent = createFakeAgent({ body: '# 会话阶段总结\n\n## 会话目标与背景\n\n- 把本次开发沉淀进语料\n\n## 可长期保留的知识\n\n- fake 经验\n' })
  const reindex = createFakeReindex()
  const service = createStructureService({ root, agent, config: {}, reindex, log: () => {} })
  const INSTRUCTIONS = '重点保留部署与排错经验'
  const result = await service.run({
    text: built.text,
    kind: 'session',
    sessionId: 'session-alpha',
    sourceLabel: 'session:session-alpha',
    collection: 'sessions',
    title: '阶段总结',
    instructions: INSTRUCTIONS,
  })
  assert(result.ok === true && result.imported === true && result.kind === 'session', '会话总结应 ok/imported/kind=session，实际 ' + JSON.stringify({ ok: result.ok, imported: result.imported, kind: result.kind }))
  assert(result.title === '阶段总结', '指定 title 应保留，实际 ' + result.title)
  const parts = String(result.target).split('/')
  assert(parts[0] === 'sessions' && parts[2] === 'processed' && parts[3] === '阶段总结.md', 'target 应是 sessions/<文件夹>/processed/阶段总结.md，实际 ' + result.target)
  assert(result.original === undefined, '会话总结不再保存原件')
  assert(!fs.existsSync(absOf(root, `sessions/${parts[1]}/originals`)), '会话总结不应创建 originals/')
  assert(fs.existsSync(absOf(root, result.target)), 'processed 会话总结应落盘')

  const doc = readFrontMatter(absOf(root, result.target))
  assert(doc.front.kind === '"session"' && doc.front.format === '"session"', 'front matter kind/format=session')
  assert(doc.front.sessionId === '"session-alpha"', 'front matter 应记录 sessionId，实际 ' + doc.front.sessionId)
  assert(doc.front.source === '"session:session-alpha"', 'front matter source 应为 session:<id>，实际 ' + doc.front.source)
  assert(doc.front.instructions === JSON.stringify(INSTRUCTIONS), 'front matter instructions')
  assert(doc.front.original === undefined, 'front matter 不应再有 original')
  assert(!Object.prototype.hasOwnProperty.call(doc.front, 'gitRemote'), '会话总结不应有 gitRemote')
  assert(doc.body.includes('# 会话阶段总结') && doc.body.includes('fake 经验'), '正文应是小代理返回的 Markdown')

  const meta = JSON.parse(fs.readFileSync(absOf(root, `sessions/${parts[1]}/.meta.json`), 'utf8'))
  assert(meta.kind === 'session' && meta.sessionId === 'session-alpha', '.meta.json kind/sessionId')
  assert(meta.processed === result.target && meta.original === undefined, '.meta.json processed 且无 original')
  assert(meta.title === '阶段总结' && meta.collection === 'sessions' && meta.aiStructured === true, '.meta.json title/collection/aiStructured')
  assert(meta.instructions === INSTRUCTIONS && meta.format === 'session', '.meta.json instructions/format')
  ok('会话总结落盘：processed/<标题>.md + .meta.json（kind=session、sessionId），不保存原件')

  // -------------------------------------------------------------------------
  // 7) 会话专用 system prompt + instructions + reindex
  // -------------------------------------------------------------------------
  assert(agent.calls.length === 1, 'agent.structure 应被调用 1 次，实际 ' + agent.calls.length)
  const call = agent.calls[0]
  assert(typeof call.system === 'string' && call.system.includes('会话总结代理') && call.system.includes('会话目标与背景'), '会话总结应收到专用 system prompt')
  assert(call.instructions === INSTRUCTIONS && call.meta.instructions === INSTRUCTIONS, 'agent 应收到 instructions')
  assert(call.meta.format === 'session' && call.meta.collection === 'sessions', 'agent meta.format=session / collection')
  assert(call.system !== undefined && !call.system.includes('仓库分析代理'), '会话总结不应使用仓库 system prompt')
  assert(call.text.includes('DSH 会话记录') && call.text.includes('人类第一条需求'), 'agent 材料应是会话 transcript')
  assert(call.maxTokens === 4096 && call.maxChars >= call.text.length, 'agent maxTokens=4096 / maxChars 足够')
  assert(reindex.calls.length === 1 && reindex.calls[0].names.join(',') === 'sessions', '应以 [collection] 触发重建，实际 ' + JSON.stringify(reindex.calls))
  assert(result.reindexJobId === 'job-fake-1', 'reindexJobId 来自 reindex.start，实际 ' + result.reindexJobId)
  ok('会话总结入参：会话专用 system + instructions + transcript；触发 reindex 并返回 reindexJobId')

  // -------------------------------------------------------------------------
  // 8) 不传 title：默认「会话总结 日期」
  // -------------------------------------------------------------------------
  const defaultTitle = await service.run({
    text: built.text,
    kind: 'session',
    sessionId: 'session-alpha',
    sourceLabel: 'session:session-alpha',
    collection: 'sessions',
  })
  assert(/^会话总结 \d{4}-\d{2}-\d{2}$/.test(defaultTitle.title), '不传 title 时应默认「会话总结 日期」，实际 ' + defaultTitle.title)
  const defaultDoc = readFrontMatter(absOf(root, defaultTitle.target))
  assert(defaultDoc.front.sessionId === '"session-alpha"' && defaultDoc.front.kind === '"session"', '默认标题的会话总结 front matter sessionId/kind')
  ok('默认标题：不传 title 时生成「会话总结 YYYY-MM-DD」')

  console.log('\n全部通过: ' + pass + ' 项（v1.4 会话转录与会话总结）')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
