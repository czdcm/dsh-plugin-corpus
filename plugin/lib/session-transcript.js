/**
 * dsh-plugin-corpus v1.4 — 把 DSH 会话的派生消息整理成可交给小代理的 transcript。
 *
 * 只读 Session 的公开投影 `deriveMessages()`，不写日志、不改会话。
 * 默认保留人类用户消息、助手可见文本/工具调用和少量工具结果；
 * 跳过 system/developer、注入上下文、推理块和图片/文件二进制。
 */
function textOfContent(content, includeToolCalls = true) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'tool-call' && includeToolCalls) parts.push(`[调用工具 ${block.name || '?'}]`)
    else if (block.type === 'image') parts.push('[图片]')
    else if (block.type === 'file') parts.push('[文件]')
  }
  return parts.join('\n')
}

function toolCallsOf(content) {
  if (!Array.isArray(content)) return []
  return content.filter((block) => block && block.type === 'tool-call').map((block) => ({
    id: block.id || '',
    name: block.name || '?',
    arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments || {}),
  }))
}

function clip(text, limit) {
  const value = String(text || '').replace(/\r\n/g, '\n').trim()
  if (value.length <= limit) return value
  return value.slice(0, limit) + `\n…[已截断 ${value.length - limit} 字]`
}

/**
 * @param session - 已加载的 DSH Session（需有 deriveMessages()）。
 * @param options.maxChars - transcript 总字数上限。
 * @param options.perMessageChars - 单条用户/助手消息上限。
 * @param options.toolResultChars - 单条工具结果上限。
 * @param options.maxMessages - 最多处理多少条消息。
 * @returns {{text:string, stats:object, warnings:string[]}}
 */
export function buildSessionTranscript(session, options = {}) {
  if (!session || typeof session.deriveMessages !== 'function') throw new Error('当前会话不可读取（Session.deriveMessages 不可用）')
  const messages = session.deriveMessages()
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('当前会话还没有消息，无法总结')
  const maxChars = Math.max(4000, Number(options.maxChars) || 60000)
  const perMessageChars = Math.max(500, Number(options.perMessageChars) || 6000)
  const toolResultChars = Math.max(200, Number(options.toolResultChars) || 800)
  const maxMessages = Math.max(1, Number(options.maxMessages) || 400)
  const toolNames = new Map()
  const sections = []
  const warnings = []
  let skipped = 0
  let included = 0
  let toolResults = 0
  let injected = 0

  for (const message of messages) {
    if (sections.length >= maxMessages) { warnings.push(`消息数超过 maxMessages=${maxMessages}，后续消息未纳入`); break }
    if (!message || typeof message !== 'object') continue
    if (message.role === 'tool') {
      const call = toolNames.get(message.toolCallId)
      const text = textOfContent(message.content)
      if (text.trim() === '') { skipped += 1; continue }
      sections.push({
        role: 'tool',
        title: `工具结果${call ? `（${call.name}）` : ''}`,
        text: clip(text, toolResultChars),
      })
      toolResults += 1
      continue
    }
    if (message.role !== 'user' && message.role !== 'assistant') { skipped += 1; continue }
    if (message.role === 'user') {
      const sourceKind = message.source && typeof message.source.kind === 'string' ? message.source.kind : ''
      if (sourceKind !== '' && sourceKind !== 'user') { injected += 1; skipped += 1; continue }
      const text = textOfContent(message.content)
      if (text.trim() === '') { skipped += 1; continue }
      sections.push({ role: 'user', title: '用户', text: clip(text, perMessageChars) })
      included += 1
      continue
    }
    const calls = toolCallsOf(message.content)
    for (const call of calls) toolNames.set(call.id, call)
    const text = textOfContent(message.content, false)
    const callText = calls.map((call) => `[调用工具 ${call.name} ${clip(call.arguments, 600)}]`).join('\n')
    const combined = [text, callText].filter((part) => part.trim() !== '').join('\n\n')
    if (combined.trim() === '') { skipped += 1; continue }
    sections.push({ role: 'assistant', title: '助手', text: clip(combined, perMessageChars) })
    included += 1
  }

  let body = sections.map((section) => `### ${section.title}\n\n${section.text}`).join('\n\n')
  if (body.length > maxChars) {
    body = body.slice(0, maxChars) + `\n\n[会话记录共 ${body.length} 字，已截断到前 ${maxChars} 字]`
    warnings.push(`会话记录超过 maxChars=${maxChars}，已截断`)
  }
  const header = [
    '# DSH 会话记录',
    '',
    `- 会话 id：${String(session.id || '')}`,
    `- 原始消息数：${messages.length}`,
    `- 纳入消息数：${included + toolResults}（用户/助手 ${included}，工具结果 ${toolResults}）`,
    `- 跳过消息数：${skipped}（其中注入上下文 ${injected}）`,
    '',
  ].join('\n')
  const text = header + body
  return {
    text,
    stats: { messages: messages.length, included, toolResults, skipped, injected, chars: text.length },
    warnings,
  }
}
