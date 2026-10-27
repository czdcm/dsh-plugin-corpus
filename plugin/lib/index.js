/**
 * dsh-plugin-corpus — 宿主半部（全局语料根 + 路径级访问管理，v1.1）。
 *
 * · 内容：<CORPUS_ROOT>/<collection>/…，整个根目录可打包搬走；
 * · 索引：<CORPUS_ROOT>/.corpus/index/<collection>.sqlite，按集合分片、可重建；
 *         重建在 worker 里跑，跨进程用 .corpus/index/.lock 仲裁；
 * · 权限：<DSH_HOME>/corpus-access.json，按工作区/会话授权到目录、glob 或单个文件；
 * · 提示词：每轮只列出本会话有权限的集合与文档，并给出“何时该检索”的约定；
 * · 面板：/api/dsh-plugin-corpus/*，给 Web GUI 的语料库页用（搜索/预览/重建/策略）。
 */
import os from 'node:os'
import path from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { authorize, ACCESS_FILE, normalize } from './access.js'
import {
  collectionNames as engineCollections,
  collectionStatus,
  importInto,
  listDocs,
  readFile,
  scanCollection,
  search,
} from './engine.js'
import { createJobRunner } from './jobs.js'
import { createPanelRoutes, PANEL_PREFIX } from './panel.js'
import { createIngestAgent } from './ingest-agent.js'
import { createIngestManager } from './ingest.js'
import { createStructureService } from './structure.js'
import { buildSessionTranscript } from './session-transcript.js'
import { expandRoot } from './settings.js'
import { deleteCollection, deleteDocument } from './trash.js'

export const name = 'corpus'
export const inject = ['tools']

export const Config = Schema.object({
  corpusRoot: Schema.string().default(''),
  promptOrder: Schema.number().min(1).max(99999).default(9000),
  maxPromptFiles: Schema.number().min(0).max(60).default(12),
  ingestProvider: Schema.string().default(''),
  ingestModel: Schema.string().default(''),
  ingestVisionProvider: Schema.string().default(''),
  ingestVisionModel: Schema.string().default(''),
  ingestMaxChars: Schema.number().min(2000).max(200000).default(24000),
  ingestTimeoutMs: Schema.number().min(10000).max(600000).default(120000),
  structureMaxChars: Schema.number().min(4000).max(200000).default(48000),
})

function log(ctx, level, message) {
  try {
    const logger = ctx.logger
    if (logger && typeof logger[level] === 'function') logger[level](`[corpus] ${message}`)
  } catch { /* 日志失败不影响主流程 */ }
}

function dshHomeOf(ctx) {
  try {
    const profile = typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined
    if (profile && typeof profile.home === 'string' && profile.home !== '') return profile.home
  } catch { /* 继续回退 */ }
  const fromEnv = process.env.DSH_HOME
  if (fromEnv && fromEnv.trim() !== '') return fromEnv
  return path.join(os.homedir(), '.dsh')
}

/** 会话主体：工作区 + 会话 id。 */
function subjectOf(agent) {
  const session = agent && agent.session
  const header = session && session.header
  const workspace = (header && header.cwd) || process.cwd()
  const id = (session && (session.id || (header && header.id))) || ''
  return { workspace, session: String(id || '') }
}

export function apply(ctx, config) {
  const dshHome = dshHomeOf(ctx)
  const root = expandRoot(config.corpusRoot, dshHome)
  const promptOrder = Number(config.promptOrder) || 9000
  const maxPromptFiles = Number(config.maxPromptFiles) || 0
  const jobs = createJobRunner({ root })
  const ingestAgent = createIngestAgent({ ctx, config, log })
  const ingest = createIngestManager({ root, dshHome, reindex: jobs, agent: ingestAgent, config, log })
  const structurer = createStructureService({ root, agent: ingestAgent, config, reindex: jobs, log })

  const collections = () => engineCollections(root)
  const scopeOf = (agent) => {
    const subject = subjectOf(agent)
    const auth = authorize(dshHome, subject, collections())
    return { subject, allow: auth.allow, names: auth.allowedCollections, policy: auth.policy }
  }

  /** 右栏权限面板用：按会话 id 解析工作区（ctx.sessions 是核心服务）。 */
  const sessionLookup = (id) => {
    try {
      if (typeof id !== 'string' || id === '') return null
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
      if (!sessions || typeof sessions.get !== 'function') return null
      const session = sessions.get(id)
      if (!session) return null
      const header = session.header || {}
      return {
        id: String(session.id || id),
        workspace: typeof header.cwd === 'string' ? header.cwd : '',
      }
    } catch {
      return null
    }
  }

  /** 校验并取出本次调用要操作的集合名（可能为空：由调用方决定空集怎么办）。 */
  const namesFor = (scope, args) => {
    let names = scope.names
    if (args && typeof args.collection === 'string' && args.collection !== '') {
      if (!names.includes(args.collection)) throw new Error(`没有访问集合 ${args.collection} 的权限`)
      names = [args.collection]
    }
    return names
  }

  // ---- 工具 ----
  ctx.tools.register(defineTool({
    name: 'corpus_search',
    description: '在语料库里按关键词检索段落（多个词空格分隔，全部命中）。返回集合、文件路径、标题、片段与行号，供 corpus_read 继续读。',
    parameters: {
      query: { type: 'string', required: true, description: '关键词，可多个' },
      limit: { type: 'number', description: '最多返回多少条，默认 8' },
      collection: { type: 'string', description: '只搜某个集合' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const scope = scopeOf(exec && exec.agent)
      const names = namesFor(scope, args)
      if (names.length === 0) {
        return JSON.stringify({ ok: false, error: '当前会话没有可访问的语料集合', root })
      }
      // 有集合但索引为空：启动后台重建，先告诉模型“在建”，不要同步阻塞。
      for (const name of names) {
        try {
          const listed = listDocs(root, { collections: [name], limit: 1 })
          if (listed.total === 0 && scanCollection(root, name).length > 0) {
            const started = jobs.start({ names: [name] })
            const job = started.job || null
            const covered = job !== null && Array.isArray(job.names) && job.names.includes(name)
            return JSON.stringify({
              ok: false,
              building: covered,
              jobId: job ? job.id : null,
              state: job ? job.state : 'idle',
              hint: covered
                ? '该集合的索引正在后台建立，请稍后重试 corpus_search；可用 corpus_status 查看进度。'
                : '该集合还没有索引，但当前有其他重建任务在运行；等它结束后用 corpus_reindex 重建该集合。',
            })
          }
        } catch { /* 建索引失败就让检索自己报错 */ }
      }
      return JSON.stringify(search(root, { collections: names, query: args.query, limit: args.limit }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'corpus_read',
    description: '按行读取语料库里的一个文件（带行号分页）。路径来自 corpus_search / corpus_list。',
    parameters: {
      path: { type: 'string', required: true, description: '相对语料根的路径，如 linux-kernel/networking.md' },
      from: { type: 'number', description: '起始行，默认 1' },
      lines: { type: 'number', description: '读取行数，默认 120，最多 400' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const scope = scopeOf(exec && exec.agent)
      const rel = String((args && args.path) || '')
      if (!scope.allow(rel)) throw new Error(`没有访问 ${rel} 的权限`)
      return JSON.stringify(readFile(root, rel, args || {}))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'corpus_list',
    description: '列出当前会话可访问的语料集合与文件（路径、标题、块数、字节）。',
    parameters: {
      collection: { type: 'string', description: '只看某个集合' },
      limit: { type: 'number', description: '每个集合最多列多少文件，默认 200' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const scope = scopeOf(exec && exec.agent)
      const names = namesFor(scope, args)
      return JSON.stringify(listDocs(root, { collections: names, limit: args && args.limit }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'corpus_reindex',
    description: '启动语料索引的后台重建（增量；force=true 全部重切）。立即返回任务 id，用 corpus_status 查看进度；同一时刻只跑一个任务。',
    parameters: {
      collection: { type: 'string', description: '只重建某个集合；省略则重建本会话可见的全部集合' },
      force: { type: 'boolean', description: '忽略文件时间全部重切' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const scope = scopeOf(exec && exec.agent)
      const names = namesFor(scope, args)
      if (names.length === 0) throw new Error('当前会话没有可访问的语料集合，无法重建')
      const result = jobs.start({ names, force: args && args.force === true })
      if (result.started) {
        return JSON.stringify({
          ok: true,
          started: true,
          jobId: result.job.id,
          state: result.job.state,
          names: result.job.names,
          startedAt: result.job.startedAt,
          hint: '重建在后台进行；用 corpus_status 查看进度，完成后即可检索。',
        })
      }
      if (result.job) {
        return JSON.stringify({
          ok: false,
          started: false,
          busy: true,
          job: result.job,
          jobId: result.job.id,
          state: result.job.state,
          progress: result.job.progress,
          hint: '已有重建任务在运行；等它结束后再启动，或用 corpus_status 查看进度。',
        })
      }
      return JSON.stringify({
        ok: false,
        started: false,
        busy: false,
        locked: result.locked || null,
        hint: '另一个 DSH 进程正在重建索引；等它释放锁后再试。',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'corpus_status',
    description: '查看语料索引状态：正在运行的重建任务、最近任务历史，以及每个集合的文档/块/索引时间。',
    parameters: {
      jobId: { type: 'string', description: '只看某个任务（来自 corpus_reindex / corpus_import 的返回）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      const status = jobs.status()
      if (args && typeof args.jobId === 'string' && args.jobId !== '') {
        const all = [...status.recent, ...(status.active ? [status.active] : [])]
        const job = all.find((item) => item.id === args.jobId) || null
        return JSON.stringify({ ok: job !== null, job, error: job === null ? `找不到任务 ${args.jobId}` : undefined })
      }
      return JSON.stringify({
        ok: true,
        root,
        active: status.active,
        recent: status.recent,
        ingest: ingest.status(),
        collections: collectionStatus(root),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'corpus_import',
    description: '把本机的一个文件或整个目录导入到语料库的某个集合（默认复制），随后可在后台重建索引。只收文本文件；符号链接/隐藏项/超限/二进制会跳过。',
    parameters: {
      path: { type: 'string', required: true, description: '源文件或目录；相对路径按当前会话工作区解析' },
      collection: { type: 'string', required: true, description: '目标集合名（不存在则创建）' },
      prefix: { type: 'string', description: '可选，导入到集合内的子目录' },
      move: { type: 'boolean', description: '导入后删除源文件，默认 false（复制）' },
      extensions: { type: 'string', description: '可选，逗号分隔的扩展名过滤（如 .md,.txt）' },
      index: { type: 'boolean', description: '导入后是否立即启动重建，默认 true' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const scope = scopeOf(exec && exec.agent)
      const collection = String((args && args.collection) || '').trim()
      if (collection === '') throw new Error('collection 不能为空')
      if (!scope.allow(collection)) throw new Error(`没有导入到集合 ${collection} 的权限`)
      const raw = String((args && args.path) || '').trim()
      if (raw === '') throw new Error('path 不能为空')
      const source = path.isAbsolute(raw) ? raw : path.resolve(scope.subject.workspace, raw)
      const extensions = typeof args.extensions === 'string' && args.extensions.trim() !== ''
        ? args.extensions.split(',').map((item) => item.trim()).filter(Boolean)
        : undefined
      const result = importInto(root, {
        source,
        collection,
        prefix: args.prefix,
        move: args.move === true,
        extensions,
      })
      let job = null
      let indexHint = '已导入；未启动重建（index=false），需要时调用 corpus_reindex。'
      if (args.index !== false) {
        const started = jobs.start({ names: [collection] })
        if (started.started) {
          job = started.job
          indexHint = '已导入；索引在后台重建，用 corpus_status 查看进度。'
        } else if (started.job) {
          indexHint = '已导入；但当前已有其他重建任务在运行，等它结束后调用 corpus_reindex 重建该集合。'
        } else {
          indexHint = '已导入；另一个 DSH 进程正在重建索引，已有任务结束后再 corpus_reindex。'
        }
      }
      return JSON.stringify({
        ok: true,
        ...result,
        jobId: job ? job.id : null,
        indexRunning: job !== null,
        hint: indexHint,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'corpus_ingest',
    description: '把本机文档（HTML/PDF/DOCX/XLSX/PPTX/图片/文本）提取成 Markdown，可选由内置摄取小代理总结/结构化后导入语料集合。启动后台任务；用 corpus_status 或 Web 面板查看进度。',
    parameters: {
      path: { type: 'string', required: true, description: '本机文件或目录；相对路径按当前会话工作区解析' },
      collection: { type: 'string', required: true, description: '目标集合名，必须是本会话有权限的集合' },
      prefix: { type: 'string', description: '可选，导入到集合内的子目录' },
      ai: { type: 'boolean', description: '是否用内置小代理做总结/结构化，默认 true' },
      index: { type: 'boolean', description: '完成后是否自动重建索引，默认 true' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const scope = scopeOf(exec && exec.agent)
      const collection = String((args && args.collection) || '').trim()
      if (collection === '') throw new Error('collection 不能为空')
      if (!scope.allow(collection)) throw new Error(`没有导入到集合 ${collection} 的权限`)
      const raw = String((args && args.path) || '').trim()
      if (raw === '') throw new Error('path 不能为空')
      const source = path.isAbsolute(raw) ? raw : path.resolve(scope.subject.workspace, raw)
      const result = ingest.start({
        paths: [source],
        collection,
        prefix: typeof args.prefix === 'string' ? args.prefix : '',
        ai: args.ai !== false,
        index: args.index !== false,
      })
      if (!result.started) {
        return JSON.stringify({ ok: false, started: false, busy: true, job: result.job, hint: '已有导入任务在运行；等它结束后再试。' })
      }
      return JSON.stringify({
        ok: true,
        started: true,
        jobId: result.job.id,
        state: result.job.state,
        job: result.job,
        hint: '导入在后台进行；用 corpus_status 或 Web 面板「语料库」查看进度。',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'corpus_structure',
    description: '与主会话交流的接口：把主会话拿到的仓库/目录/文件/文本交给内置小代理总结并结构化。典型用法：先按用户要求把 GitHub 仓库 git clone/pull 到本地，再调用本工具传 path（目录或文件）和 collection；或把抓取到的网页/API 文本用 text 传入。同步返回结构化 Markdown，并写入 <collection>/<import>/processed/、触发索引重建；不保存源文件。',
    parameters: {
      path: { type: 'string', description: '本机仓库/目录/文件路径；相对路径按当前会话工作区解析。与 text 二选一' },
      text: { type: 'string', description: '主会话直接提供的文本内容（例如抓到的 README/网页/API 结果）。与 path 二选一' },
      collection: { type: 'string', description: '目标集合名；import=true（默认）时必填且必须有权限；只总结不导入时可省略' },
      prefix: { type: 'string', description: '可选，导入到集合内的子目录' },
      title: { type: 'string', description: '可选，结果标题；不填则从内容/仓库名推断' },
      instructions: { type: 'string', description: '可选，额外分析要求，例如「重点总结架构和数据流」「面向二次开发」' },
      maxFiles: { type: 'number', description: '可选，仓库扫描/摘录的文件数上限，默认 300' },
      maxChars: { type: 'number', description: '可选，送给模型的材料字数上限，默认 48000' },
      import: { type: 'boolean', description: '是否写入语料库，默认 true；false 时只返回结构化结果' },
      reindex: { type: 'boolean', description: '写入后是否触发集合重建，默认 true' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const scope = scopeOf(exec && exec.agent)
      const importDoc = args.import !== false
      const collection = String((args && args.collection) || '').trim()
      if (importDoc) {
        if (collection === '') throw new Error('导入语料时 collection 不能为空')
        if (!scope.allow(collection)) throw new Error(`没有写入集合 ${collection} 的权限`)
      }
      const rawPath = String((args && args.path) || '').trim()
      const text = typeof (args && args.text) === 'string' ? args.text : ''
      if (rawPath === '' && text === '') throw new Error('path 与 text 至少提供一个')
      if (rawPath !== '' && text !== '') throw new Error('path 与 text 只能二选一')
      const sourcePath = rawPath === ''
        ? ''
        : (path.isAbsolute(rawPath) ? rawPath : path.resolve(scope.subject.workspace, rawPath))
      const result = await structurer.run({
        path: sourcePath || undefined,
        text: text === '' ? undefined : text,
        collection,
        prefix: typeof args.prefix === 'string' ? args.prefix : '',
        title: typeof args.title === 'string' ? args.title : '',
        instructions: typeof args.instructions === 'string' ? args.instructions : '',
        maxFiles: args.maxFiles,
        maxChars: args.maxChars,
        import: importDoc,
        reindex: args.reindex !== false,
      })
      const body = String(result.body || '')
      const limit = 24000
      const truncated = body.length > limit
      return JSON.stringify({
        ok: true,
        imported: result.imported,
        kind: result.kind,
        title: result.title,
        source: result.source,
        target: result.target || null,
        folder: result.folder || null,
        collection: result.collection || collection,
        git: result.git || null,
        stats: result.stats || null,
        warnings: Array.isArray(result.warnings) ? result.warnings : [],
        reindexJobId: result.reindexJobId || null,
        chars: result.chars || body.length,
        body: truncated ? body.slice(0, limit) + '\n\n[工具输出已截断；完整内容用 corpus_read 读 target]' : body,
        bodyTruncated: truncated,
        hint: result.imported
          ? `已写入 ${result.target}；用 corpus_read 读取全文，检索会自动使用 processed/。`
          : '仅返回结构化结果，未写入语料库（import=false）。',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'corpus_summarize_session',
    description: '把当前（或指定）DSH 会话的思路、决策、完成内容和遗留问题总结并结构化后导入语料库。典型场景：一个会话做到收尾时，调用本工具把这次的经验沉淀进 collection；它会读取会话的公开消息投影（不读 system/developer、不读图片二进制），用内置小代理生成 Markdown，写入 processed/ 并触发重建。',
    parameters: {
      collection: { type: 'string', description: '目标集合名；import=true（默认）时必填且必须有权限' },
      prefix: { type: 'string', description: '可选，导入到集合内的子目录' },
      title: { type: 'string', description: '可选，会话总结标题；不填自动生成' },
      instructions: { type: 'string', description: '可选，额外总结要求，例如「重点保留部署与排错经验」' },
      maxChars: { type: 'number', description: '可选，会话 transcript 字数上限，默认 60000' },
      sessionId: { type: 'string', description: '可选，默认当前会话；填其他会话 id 时需该会话仍可读取' },
      import: { type: 'boolean', description: '是否写入语料库，默认 true；false 时只返回总结' },
      reindex: { type: 'boolean', description: '写入后是否触发集合重建，默认 true' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const scope = scopeOf(exec && exec.agent)
      const importDoc = args.import !== false
      const collection = String((args && args.collection) || '').trim()
      if (importDoc) {
        if (collection === '') throw new Error('导入语料时 collection 不能为空')
        if (!scope.allow(collection)) throw new Error(`没有写入集合 ${collection} 的权限`)
      }
      const requestedId = String((args && args.sessionId) || '').trim()
      let session = exec && exec.agent ? exec.agent.session : null
      if (requestedId !== '') {
        if (!session || String(session.id || '') !== requestedId) {
          let store = null
          try { store = typeof ctx.get === 'function' ? ctx.get('sessions') : null } catch { store = null }
          if (!store || typeof store.get !== 'function') throw new Error('sessions 服务不可用，无法读取指定会话')
          session = store.get(requestedId)
          if (!session) throw new Error(`找不到会话 ${requestedId}`)
        }
      }
      if (!session) throw new Error('当前工具上下文没有会话（不在 agent 会话中）')
      const maxTranscriptChars = Math.max(4000, Math.min(160000, Number(args.maxChars) || 60000))
      const transcript = buildSessionTranscript(session, { maxChars: maxTranscriptChars })
      const result = await structurer.run({
        text: transcript.text,
        kind: 'session',
        sourceLabel: `session:${String(session.id || requestedId || '')}`,
        sessionId: String(session.id || requestedId || ''),
        collection,
        prefix: typeof args.prefix === 'string' ? args.prefix : '',
        title: typeof args.title === 'string' ? args.title : '',
        instructions: typeof args.instructions === 'string' ? args.instructions : '',
        maxChars: Math.min(160000, transcript.text.length + 4000),
        import: importDoc,
        reindex: args.reindex !== false,
      })
      const body = String(result.body || '')
      const limit = 24000
      const truncated = body.length > limit
      return JSON.stringify({
        ok: true,
        imported: result.imported,
        kind: 'session',
        title: result.title,
        sessionId: String(session.id || requestedId || ''),
        target: result.target || null,
        folder: result.folder || null,
        collection: result.collection || collection,
        transcript: transcript.stats,
        stats: result.stats || null,
        warnings: [...transcript.warnings, ...(Array.isArray(result.warnings) ? result.warnings : [])],
        reindexJobId: result.reindexJobId || null,
        chars: result.chars || body.length,
        body: truncated ? body.slice(0, limit) + '\n\n[工具输出已截断；完整内容用 corpus_read 读 target]' : body,
        bodyTruncated: truncated,
        hint: result.imported
          ? `已写入 ${result.target}；用 corpus_read 读取全文，检索会自动使用 processed/。`
          : '仅返回会话总结，未写入语料库（import=false）。',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'corpus_delete',
    description: '删除一篇语料（path）或整个集合（collection），二者选一。删除是软删除：内容移到 <CORPUS_ROOT>/.corpus/trash/<时间>/ 下，可人工恢复；删除文档会触发该集合重建。',
    parameters: {
      path: { type: 'string', description: '要删除的 processed 语料相对路径，例如 dsh-docs/2026.../processed/foo.md；与 collection 二选一' },
      collection: { type: 'string', description: '要删除的整个集合名；与 path 二选一' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const scope = scopeOf(exec && exec.agent)
      const relPath = String((args && args.path) || '').trim()
      const collection = String((args && args.collection) || '').trim()
      if ((relPath === '') === (collection === '')) throw new Error('path 与 collection 必须二选一')
      let activeJob = null
      try { activeJob = jobs && typeof jobs.status === 'function' ? jobs.status().active : null } catch { activeJob = null }
      if (activeJob !== null) throw new Error('还有重建任务在运行，等任务结束后再删除语料')
      try {
        if (relPath !== '') {
          const first = relPath.replace(/\\/g, '/').split('/')[0]
          if (!scope.allow(first)) throw new Error(`没有删除集合 ${first} 的权限`)
          const result = deleteDocument(root, relPath)
          let reindexJobId = null
          try {
            const started = jobs.start({ names: [result.collection] })
            reindexJobId = started && started.job ? started.job.id : null
          } catch { reindexJobId = null }
          return JSON.stringify({ ok: true, ...result, reindexJobId, hint: '已移入 .corpus/trash，可人工恢复；索引正在后台重建。' })
        }
        if (!scope.allow(collection)) throw new Error(`没有删除集合 ${collection} 的权限`)
        const result = deleteCollection(root, collection)
        return JSON.stringify({ ok: true, ...result, hint: '集合已移入 .corpus/trash/collections，可人工恢复。' })
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error))
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'corpus_access',
    description: '查看本会话的语料访问范围：策略文件位置、默认动作、可访问的集合与文件模式。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, exec) {
      const scope = scopeOf(exec && exec.agent)
      const policy = scope.policy
      return JSON.stringify({
        ok: true,
        root,
        accessFile: path.join(dshHome, ACCESS_FILE),
        policy: policy === null ? '未配置（默认只允许本工作区的 corpus/）' : { default: policy.default || 'deny' },
        workspace: normalize(scope.subject.workspace),
        session: scope.subject.session,
        collections: scope.names,
        fileCount: (() => {
          try { return listDocs(root, { collections: scope.names, limit: 1000 }).total } catch { return 0 }
        })(),
      })
    },
  }))

  // ---- 提示词：只列有权限的集合 ----
  const summaries = new Map()
  const promptText = (agent) => {
    const scope = scopeOf(agent)
    if (scope.names.length === 0) return ''
    const key = [normalize(scope.subject.workspace), scope.subject.session, scope.names.join(',')].join('|')
    const hit = summaries.get(key)
    if (hit && Date.now() - hit.at < 15000) return hit.text
    let text = ''
    try {
      const listed = listDocs(root, { collections: scope.names, limit: 1000 })
      if (listed.total > 0) {
        const parts = listed.collections.map((collection) => `${collection.name}（${collection.docs} 篇）`).join('、')
        const files = listed.collections.flatMap((collection) => collection.files)
        const titles = files.slice(0, maxPromptFiles).map((file) => file.title).join('、')
        const more = files.length > maxPromptFiles ? ` 等 ${files.length} 篇` : ''
        text = [
          `本工作区可访问语料库：${parts}。`,
          titles ? `文档：${titles}${more}。` : '',
          '',
          '检索约定：',
          '- 问题涉及这些文档的具体内容（配置项、接口、实现细节、原文出处）时，先 `corpus_search` 检索，再 `corpus_read` 按行读原文；不要凭记忆复述。',
          '- 检索用关键词而不是整句；命中后按 path 与行号引用。',
          '- 找不到就换同义词再搜；索引为空时先 `corpus_reindex`（后台任务，随后用 `corpus_status` 看进度）；新增语料用 `corpus_import` 导入。',
        ].filter((line) => line !== '').join('\n')
      } else {
        text = '本工作区配置了可访问的语料集合，但索引还没建：需要查文档时先调用 `corpus_reindex`（后台任务，用 `corpus_status` 看进度）。'
      }
    } catch { text = '' }
    if (text !== '') {
      text += '\n- 用户要求把 GitHub 仓库、网页或主会话抓到的内容总结进语料时：先把仓库 clone/pull 到本机，再调用 `corpus_structure`（仓库/目录/文件用 `path`，抓取的文本用 `text`，加 `collection`）；它会同步返回结构化 Markdown、写入 processed/ 并触发重建，之后用 `corpus_read` 读全文。'
      text += '\n- 会话收尾、用户说“把这次会话/思路总结进知识库”时：调用 `corpus_summarize_session`（默认当前会话，`collection` 必填）；它读取会话公开消息投影，生成 processed/ 下的会话总结并触发重建。'
      text += '\n- 用户要删除某篇语料或某个集合时：调用 `corpus_delete`（`path` 或 `collection` 二选一）；删除是软删除，移到 `.corpus/trash`，可从那里人工恢复。'
    }
    summaries.set(key, { at: Date.now(), text })
    return text
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (scope) => {
      try {
        if (!scope.systemPrompt || typeof scope.systemPrompt.context !== 'function') {
          log(ctx, 'warn', 'systemPrompt 服务不可用')
          return
        }
        scope.effect(() => scope.systemPrompt.context({
          name: 'corpus.index',
          order: promptOrder,
          text: ({ agent }) => promptText(agent),
        }), 'corpus: prompt context')
        log(ctx, 'info', `语料根 ${root}；策略 ${path.join(dshHome, ACCESS_FILE)}`)
      } catch (error) {
        log(ctx, 'warn', `提示词接入失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  // ---- 面板接口：webServer 可能比本插件晚挂载，用 ctx.inject 等它就绪 ----
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      try {
        const routes = createPanelRoutes({ root, dshHome, jobs, sessionLookup, ingest })
        for (const route of routes) {
          webCtx.effect(() => webCtx.webServer.register(route), `corpus: ${route.path}`)
        }
        log(ctx, 'info', `面板接口已挂载：${PANEL_PREFIX}`)
      } catch (error) {
        log(ctx, 'warn', `面板接口注册失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  return () => {
    try { jobs.dispose() } catch { /* 已关闭 */ }
    try { ingest.dispose() } catch { /* 已关闭 */ }
    summaries.clear()
  }
}
