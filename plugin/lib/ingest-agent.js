/**
 * dsh-plugin-corpus — 内置摄取小代理（v1.3）。
 *
 * 固定提示词、单轮、后台的模型调用：只做内容识别、总结、结构化，
 * 不进入主会话、不调用工具、不往 Session 里写消息。
 *
 * 支持两种输入：
 *   · 纯文本（来自 HTML/PDF/Office 提取）；
 *   · 图片（png/jpg/webp，经 ctx.attachments 变成 durable image attachment
 *     后作为 image content block 交给视觉模型；PDF 扫描页也是图片的一种）。
 *
 * 模型路由：
 *   config.ingestProvider/ingestModel > ctx.agentDefaultModel.currentSelection()
 *   > 'deepseek-official' / 'deepseek-flash'
 */
const SYSTEM_PROMPT = `你是「语料摄取小代理」，只做内容识别、提取、总结和结构化，不闲聊、不调用工具、不编造原文没有的事实。
输入可能是纯文本，也可能包含文档页面/图片。若包含图片，请先识别图片中的文字、表格、标题层级与版式关系，再总结；看不清或不存在的部分写“原文未说明”。
请输出严格 Markdown（不要用代码围栏包住整篇），尽量遵守：
# <准确标题>
> 来源：<文件名/格式/作者等已知信息>；一句话定位

## 摘要
用 3-6 句话说清这份文档是什么、解决什么问题、最重要的结论。

## 关键要点
- 5-10 条要点，保留数字、配置项、接口名、命令等原文关键信息。

## 结构化内容
按原文的主要章节/步骤/表格/公式组织；保留必要的表格、列表、代码块；不要大段照抄，也不要丢掉关键细节。
遇到不确定或原文缺失处写“原文未说明”。

## 公式
所有数学公式都必须用 LaTeX 表示：行内用 $...$，独立公式用 $$...$$。
不要把公式写成 Unicode 符号或普通文本；分数用 \frac，根号用 \sqrt，求和/积分用 \sum/\int，上下标用 ^/_。
保留公式编号（如 (13-34)）；无法确认的公式写“原文未说明”，不要编造。
插图、流程图、图表不要求逐字转写，但必须说明其对象关系和逻辑（流程方向、层级、箭头、分组、坐标轴）；看不清处写“图示无法辨认”；图中的公式、标注和关键数字必须保留。

## 术语与关键词
- 列 5-15 个术语/关键词，必要时一句话解释。

如果原文很短，可以省略没有内容的章节；不要输出与文档无关的内容。`

/** Office 专用提示词：对象关系/版面逻辑比纯文本更重要。 */
export const OFFICE_SYSTEM_PROMPT = `你是「Office 文档结构化代理」，把 Word/Excel/PowerPoint 的内容和逻辑转成可检索的 Markdown，不闲聊、不调用工具、不编造原文没有的事实。

输入包含：
- officecli 提取的页/幻灯片、文本、标题、表格、公式；
- 对象树：Group、Shape、Picture、Table、Chart、Connector、OLE 及其层级/坐标/替代文本；
- 可选的版式缩略图（真实渲染图）。

请严格输出 Markdown：
# <准确标题>
> 来源：<文件名/格式>；文档类型与一句话定位

## 摘要
用 3-6 句话说清文档主题、目的和最重要的结论。

## 逐页/逐表结构
按原始顺序组织：
- Word：标题层级、段落、表格、公式；
- Excel：工作表、表头、数据类型、公式、关键结论；
- PowerPoint：每一页一个 \`### Slide N\`，写清本页标题、文字要点、图形/图表表达的关系和结论。

对图形/图表必须描述：
- 有哪些对象、如何分组/连接/对齐；
- 箭头或流程方向、层级关系、坐标轴或图例含义；
- 该图支持什么结论。
不要只罗列文本框，也不要把“图示略”当默认答案；无法辨认时明确写“图示无法辨认”，但保留可读的标注、数字、公式。

## 表格
将表格转成 Markdown；保留表头、单位、公式和关键数字，不要把表格拆散成无上下文段落。

## 公式
所有数学公式用 LaTeX：行内 $...$，独立 $$...$$；保留公式编号。Excel 公式保留为代码形式并写清 Sheet/Cell；无法确认时写“原文未说明”。

## 术语与关键词
列 5-15 个术语/关键词。

不要输出与文档无关的内容；输入被截断时只总结可见部分并注明。`

function stripFence(text) {
  const value = String(text || '').trim()
  const match = value.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```$/)
  return match ? match[1].trim() : value
}

function metaText(meta) {
  const lines = []
  if (meta && typeof meta === 'object') {
    if (typeof meta.title === 'string' && meta.title !== '') lines.push(`标题：${meta.title}`)
    if (typeof meta.source === 'string' && meta.source !== '') lines.push(`来源：${meta.source}`)
    if (typeof meta.format === 'string' && meta.format !== '') lines.push(`格式：${meta.format}`)
    if (typeof meta.collection === 'string' && meta.collection !== '') lines.push(`目标集合：${meta.collection}`)
    if (Array.isArray(meta.warnings) && meta.warnings.length > 0) lines.push(`提取提示：${meta.warnings.join('；')}`)
    if (typeof meta.instructions === 'string' && meta.instructions.trim() !== '') lines.push(`本次任务要求：${meta.instructions.trim()}`)
  }
  return lines.length > 0 ? `文档元数据：\n${lines.join('\n')}\n\n---\n` : ''
}

/**
 * @param ctx - Cordis 插件上下文（ctx.get('llm') / ctx.get('attachments') / ctx.get('agentDefaultModel')）。
 * @param config - 插件配置（ingestProvider/ingestModel/ingestMaxChars/ingestTimeoutMs）。
 * @param log - 可选日志函数 (level, message)。
 */
export function createIngestAgent({ ctx, config, log }) {
  const read = (name) => {
    try { return typeof ctx.get === 'function' ? ctx.get(name) : undefined } catch { return undefined }
  }
  const llm = read('llm')
  const attachments = read('attachments')
  const defaultSelection = (() => {
    try {
      const service = read('agentDefaultModel')
      if (service && typeof service.currentSelection === 'function') return service.currentSelection()
    } catch { /* 没有默认模型服务 */ }
    return null
  })()

  const route = () => {
    const provider = String(config.ingestProvider || '').trim()
      || (defaultSelection && typeof defaultSelection.provider === 'string' ? defaultSelection.provider : '')
      || 'deepseek-official'
    const model = String(config.ingestModel || '').trim()
      || (defaultSelection && typeof defaultSelection.model === 'string' ? defaultSelection.model : '')
      || 'deepseek-flash'
    if (provider === '' || model === '') return null
    const routeValue = { provider, model }
    if (defaultSelection && defaultSelection.reasoningEffort) routeValue.reasoningEffort = defaultSelection.reasoningEffort
    return routeValue
  }

  const visionRoute = () => {
    const provider = String(config.ingestVisionProvider || '').trim()
    const model = String(config.ingestVisionModel || '').trim()
    if (provider !== '' && model !== '') return { provider, model }
    return route()
  }

  const available = () => Boolean(llm && typeof llm.stream === 'function' && route() !== null)

  const streamMarkdown = async (content, timeoutMs, options = {}) => {
    if (!available()) throw new Error('LLM 服务或默认模型不可用')
    const modelOptions = options.route || route()
    const controller = new AbortController()
    const timer = setTimeout(() => {
      try { controller.abort() } catch { /* 已结束 */ }
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      const stream = llm.stream({
        provider: modelOptions.provider,
        model: modelOptions.model,
        reasoningEffort: modelOptions.reasoningEffort,
        system: typeof options.system === 'string' && options.system.trim() !== '' ? options.system : SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
        maxTokens: Math.max(512, Number(options.maxTokens) || 4096),
        temperature: 0.2,
        signal: controller.signal,
      })
      let output = ''
      let failure = null
      for await (const chunk of stream) {
        if (!chunk || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta') {
          output += String(chunk.text || '')
        } else if (chunk.type === 'finish' && chunk.reason && typeof chunk.reason === 'object') {
          if (chunk.reason.kind === 'error') failure = chunk.reason.failure && chunk.reason.failure.message ? chunk.reason.failure.message : '模型调用失败'
          else if (chunk.reason.kind === 'aborted') failure = '模型调用被中止'
        }
      }
      if (failure !== null) throw new Error(failure)
      const markdown = stripFence(output)
      if (markdown === '') throw new Error('模型返回空内容')
      return markdown
    } finally {
      clearTimeout(timer)
    }
  }

  const timeoutOf = () => Math.max(10000, Number(config.ingestTimeoutMs) || 120000)

  const structure = async ({ text, meta, instructions, system, maxChars, maxTokens }) => {
    const limit = Math.max(2000, Number(maxChars) || Number(config.ingestMaxChars) || 24000)
    const raw = String(text || '')
    const clipped = raw.length > limit
      ? raw.slice(0, limit) + `\n\n[注意：原文共 ${raw.length} 字，已截断到前 ${limit} 字供本次结构化]`
      : raw
    const effectiveMeta = instructions && String(instructions).trim() !== ''
      ? { ...(meta || {}), instructions: String(instructions) }
      : meta
    return streamMarkdown([{ type: 'text', text: metaText(effectiveMeta) + clipped }], timeoutOf(), { system, maxTokens })
  }

  /** 该模型/运行环境是否可以接收图片 content block。 */
  /** 图片输入能力的详细诊断；UI 用它解释“Vision 不可用”。 */
  const visionStatus = async () => {
    if (!attachments || typeof attachments.saveImages !== 'function') {
      return { available: false, reason: 'attachments 服务不可用', provider: null, model: null }
    }
    if (!llm || typeof llm.stream !== 'function') {
      return { available: false, reason: 'LLM 服务不可用', provider: null, model: null }
    }
    const options = visionRoute()
    if (options === null) return { available: false, reason: '没有可用模型', provider: null, model: null }
    try {
      if (typeof llm.resolveModelInfo === 'function') {
        const info = await llm.resolveModelInfo(options.provider, options.model)
        const modalities = info && Array.isArray(info.inputModalities) ? info.inputModalities : null
        if (modalities !== null && !modalities.some((item) => String(item).toLowerCase().includes('image'))) {
          return {
            available: false,
            reason: `DSH 模型 ${options.provider}/${options.model} 未声明图片输入能力（模型选项里未启用“图片”）`,
            provider: options.provider,
            model: options.model,
            inputModalities: modalities,
          }
        }
      }
    } catch (error) {
      return {
        available: false,
        reason: `无法读取模型能力：${error instanceof Error ? error.message : String(error)}`,
        provider: options.provider,
        model: options.model,
      }
    }
    return { available: true, reason: null, provider: options.provider, model: options.model }
  }

  const supportsImages = async () => (await visionStatus()).available

  const structureImages = async ({ images, meta, text, system, maxChars, maxTokens }) => {
    if (!attachments || typeof attachments.saveImages !== 'function') throw new Error('图片附件服务不可用')
    const inputs = []
    for (const image of Array.isArray(images) ? images : []) {
      if (!image || !image.data) continue
      inputs.push({
        data: image.data instanceof Uint8Array ? image.data : new Uint8Array(image.data),
        mediaType: image.mediaType || 'image/png',
        name: image.name || 'page',
      })
    }
    if (inputs.length === 0) throw new Error('没有可识别的图片')
    const saved = await attachments.saveImages(inputs)
    const limit = Math.max(2000, Number(maxChars) || Number(config.ingestMaxChars) || 24000)
    const digest = String(text || '')
    const clipped = digest.length > limit ? digest.slice(0, limit) + `\n\n[注意：结构说明共 ${digest.length} 字，已截断]` : digest
    const content = [
      {
        type: 'text',
        text: `${metaText(meta)}${clipped ? 'officecli 已提取的文档结构与对象关系：\n' + clipped + '\n\n' : ''}以上是同一份文档的 ${saved.length} 张版式图片。请结合对象关系和真实版式识别文字、表格、图形逻辑，按系统提示输出 Markdown。`,
      },
    ]
    for (const item of saved) {
      const ref = item && item.image ? item.image : item
      if (ref) content.push({ type: 'image', attachment: ref })
    }
    return streamMarkdown(content, timeoutOf(), { system, maxTokens, route: visionRoute() })
  }

  if (log) log('info', `摄取小代理：${available() ? '可用' : '不可用'}（${route() ? `${route().provider}/${route().model}` : '无模型'}）`)
  return { available, route, visionRoute, structure, structureImages, supportsImages, visionStatus }
}
