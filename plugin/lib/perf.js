/**
 * dsh-plugin-corpus — 性能工具（v1.4.2）。
 *
 * 目标：插件在 DSH 宿主进程里跑，任何同步长任务都会连带卡住整个 GUI
 * （会话历史加载、面板轮询、其他会话的工具调用）。这里集中提供三件套：
 *
 *   · createSlicer —— 把「逐个文件」的同步循环切成小片，定期 await 让出事件循环；
 *   · boundJson   —— 工具输出硬上限，避免单次调用把几 MB 文本写进会话历史；
 *   · memoTtl     —— 极短的读缓存，压掉面板/提示词里的重复扫描。
 *
 * 全部是纯函数/小工具，不引用 DSH 宿主 API，方便测试。
 */

/** 单调毫秒（不受系统时间调整影响）。 */
export function nowMs() {
  const value = Number(process.hrtime.bigint() / 1000000n)
  return Number.isFinite(value) ? value : Date.now()
}

/**
 * 协作式让出调度器。
 * @param {{everyItems?: number, everyMs?: number}} options 每 N 项或每 N 毫秒让出一次。
 * @returns {{slice: (force?: boolean) => Promise<void>}} 每处理完一项调用一次 slice()。
 */
export function createSlicer(options = {}) {
  const everyItems = Math.max(1, Number(options.everyItems) || 32)
  const everyMs = Math.max(1, Number(options.everyMs) || 8)
  let items = 0
  let mark = nowMs()
  const slice = async (force = false) => {
    items += 1
    if (force || items >= everyItems || nowMs() - mark >= everyMs) {
      items = 0
      mark = nowMs()
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  return { slice }
}

function shrink(value, level, depth = 0) {
  if (typeof value === 'string') {
    return value.length > level.maxString ? value.slice(0, level.maxString) + '…' : value
  }
  if (Array.isArray(value)) {
    if (value.length <= level.maxArray) return value.map((item) => shrink(item, level, depth + 1))
    const kept = value.slice(0, level.maxArray).map((item) => shrink(item, level, depth + 1))
    kept.push(`…（另有 ${value.length - level.maxArray} 项未显示）`)
    return kept
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = shrink(item, level, depth + 1)
    return out
  }
  return value
}

function safeStringify(value) {
  try { return JSON.stringify(value) } catch { return JSON.stringify({ ok: false, error: '输出无法序列化' }) }
}

/**
 * 把工具输出压到 maxChars 以内，且**始终返回合法 JSON 字符串**。
 * 逐级收紧字符串长度与数组长度；缩短后在根对象上标记 _truncated。
 * @param {unknown} value 要返回给模型的对象。
 * @param {number} maxChars 上限（字符数，默认 24000）。
 * @returns {string} JSON 字符串。
 */
export function boundJson(value, maxChars = 24000) {
  const limit = Math.max(1000, Number(maxChars) || 24000)
  let json = safeStringify(value)
  if (json.length <= limit) return json
  const levels = [
    { maxString: 4000, maxArray: 60 },
    { maxString: 1200, maxArray: 24 },
    { maxString: 400, maxArray: 8 },
    { maxString: 120, maxArray: 3 },
    { maxString: 40, maxArray: 1 },
  ]
  const headroom = Math.max(200, Math.min(2000, Math.floor(limit / 20)))
  for (const level of levels) {
    const shrunk = shrink(value, level)
    if (shrunk && typeof shrunk === 'object' && !Array.isArray(shrunk)) {
      shrunk._truncated = true
      shrunk._maxChars = limit
      shrunk._hint = '输出超过上限已压缩；需要完整内容时缩小查询范围或分页读取。'
    }
    json = safeStringify(shrunk)
    if (json.length <= limit - headroom) return json
  }
  return safeStringify({
    ok: true,
    _truncated: true,
    _maxChars: limit,
    _hint: '输出过大，已省略明细；请缩小查询范围、分页读取或先看摘要。',
    preview: json.slice(0, Math.max(200, limit - 400)),
  })
}

/**
 * 极短 TTL 缓存：面板轮询、提示词目录这类「同一秒内重复算」的读取用。
 * 按参数区分缓存（不同 collection/limit 不会串味），最多保留 64 个键。
 * 注意：fn 抛错时不缓存，直接向上抛。
 */
export function memoTtl(fn, ttlMs = 1500) {
  const entries = new Map()
  const maxEntries = 64
  return function cachedCall(...args) {
    const key = args.length === 0 ? '' : JSON.stringify(args)
    const now = Date.now()
    const hit = entries.get(key)
    if (hit && now - hit.at < ttlMs) return hit.value
    const value = fn(...args)
    if (entries.size >= maxEntries) entries.clear()
    entries.set(key, { at: now, value })
    return value
  }
}
