/**
 * dsh-plugin-corpus — 访问管理。
 *
 * 语料放在全 DSH 共用的根目录里（可随身搬走），但“谁能看哪一块”是机器本地的策略，
 * 单独存在 <DSH_HOME>/corpus-access.json。
 *
 * 规则：
 *   · 主体：workspace（会话工作区，绝对路径）或 session（具体会话 id）；
 *   · 目标：paths[]，支持目录前缀、通配符与单个文件；
 *   · 判定：deny 优先于 allow；同一路径上更具体的规则不影响 deny/allow 的先后；
 *   · 缺省：文件里的 default（缺省 deny）；策略文件不存在时，允许各工作区自己的 corpus/。
 */
import fs from 'node:fs'
import path from 'node:path'

export const ACCESS_FILE = 'corpus-access.json'

/** Windows 上路径大小写不敏感；统一成正斜杠、小写、去尾斜杠。 */
export function normalize(value) {
  let text = String(value || '').replace(/\\/g, '/').trim()
  text = text.replace(/\/{2,}/g, '/')
  if (text.endsWith('/') && text.length > 1) text = text.slice(0, -1)
  if (text.startsWith('./')) text = text.slice(2)
  return process.platform === 'win32' ? text.toLowerCase() : text
}

function globToRegExp(pattern) {
  const normalized = normalize(pattern)
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const body = escaped
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/\u0000/g, '.*')
  return new RegExp('^' + body + '$')
}

/**
 * 目标路径是否被某条规则命中。
 * 无通配符的模式按“目录前缀或该文件本身”理解：`linux-kernel` 覆盖 `linux-kernel/x.md`。
 */
export function matchesTarget(pattern, relPath) {
  const target = normalize(relPath)
  const normalized = normalize(pattern)
  if (normalized === '') return false
  if (!/[*?]/.test(normalized)) {
    if (target === normalized) return true
    return target.startsWith(normalized + '/')
  }
  const regexp = globToRegExp(normalized)
  if (regexp.test(target)) return true
  // `dir/*` 也应覆盖更深层，用前缀再判断一次
  const prefix = normalized.replace(/\/\*+$/, '')
  if (prefix !== normalized && (target === prefix || target.startsWith(prefix + '/'))) return true
  return false
}

/** 规则的可选到期时刻（epoch ms）；没有/非法返回 null。 */
export function ruleExpiresAt(rule) {
  if (!rule || typeof rule !== 'object') return null
  const raw = rule.expiresAt
  if (raw === undefined || raw === null || raw === '') return null
  const value = typeof raw === 'number' ? raw : Date.parse(String(raw))
  return Number.isFinite(value) ? value : null
}

/** 规则是否已过期；过期规则在 grant/deny 两侧都等同于不存在。 */
export function ruleExpired(rule, now = Date.now()) {
  const at = ruleExpiresAt(rule)
  return at !== null && now >= at
}

function subjectsOf(rule) {
  if (!rule || typeof rule !== 'object') return { session: null, workspace: null }
  const session = typeof rule.session === 'string' && rule.session !== '' ? rule.session : null
  const workspace = typeof rule.workspace === 'string' && rule.workspace !== '' ? normalize(rule.workspace) : null
  return { session, workspace }
}

function ruleApplies(rule, subject) {
  if (!rule || typeof rule !== 'object') return false
  if (ruleExpired(rule)) return false
  const { session, workspace } = subjectsOf(rule)
  if (session !== null && session !== subject.session) return false
  if (workspace !== null && workspace !== '*' && workspace !== subject.workspace) return false
  // 既没 workspace 也没 session 的规则是全局规则（典型用法：全局 deny 某类路径）
  if (session === null && workspace === null) return true
  const patterns = Array.isArray(rule.paths) ? rule.paths : (typeof rule.path === 'string' ? [rule.path] : [])
  return patterns.length > 0
}

/** 读取策略文件；不存在时返回 null。 */
export function loadAccess(dshHome) {
  const file = path.join(dshHome, ACCESS_FILE)
  if (!fs.existsSync(file)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 为一次调用建立判定器。
 * @param dshHome - DSH 主目录（策略文件所在处）。
 * @param subject - { workspace, session }。
 * @returns { allow(relPath): boolean, allowedCollections(names): string[], policy: object }
 */
export function authorize(dshHome, subject, collectionNames = []) {
  const policy = loadAccess(dshHome)
  const target = { workspace: normalize(subject.workspace), session: subject.session || '' }
  const grants = policy && Array.isArray(policy.grants) ? policy.grants : []
  const denies = policy && Array.isArray(policy.deny) ? policy.deny : []
  const fallbackAllow = policy === null // 没策略文件：允许本工作区自己的 corpus/

  const allow = (relPath) => {
    const rel = normalize(String(relPath || ''))
    for (const rule of denies) {
      if (!ruleApplies(rule, target)) continue
      const patterns = Array.isArray(rule.paths) ? rule.paths : []
      if (patterns.some((pattern) => matchesTarget(pattern, rel))) return false
    }
    for (const rule of grants) {
      if (!ruleApplies(rule, target)) continue
      const patterns = Array.isArray(rule.paths) ? rule.paths : []
      if (patterns.some((pattern) => matchesTarget(pattern, rel))) return true
    }
    if (policy && policy.default === 'allow') return true
    if (fallbackAllow) return rel.startsWith('corpus/')
    return false
  }

  const allowedCollections = collectionNames.filter((name) => {
    const rel = normalize(name)
    if (allow(rel)) return true
    // 集合本身没被直接命中，但可能有某条更细的授权指向它内部的文件
    for (const rule of grants) {
      if (!ruleApplies(rule, target)) continue
      const patterns = Array.isArray(rule.paths) ? rule.paths : []
      for (const pattern of patterns) {
        const p = normalize(pattern)
        if (p === rel || p.startsWith(rel + '/')) return true
      }
    }
    return false
  })

  return { allow, allowedCollections, policy, subject: target }
}
