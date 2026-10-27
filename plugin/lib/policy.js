/**
 * dsh-plugin-corpus — 访问策略的读写与校验（v1.2）。
 *
 * 策略文件仍然是 <DSH_HOME>/corpus-access.json；这里只负责：
 *   · 读（容忍不存在/损坏）；
 *   · 校验并规范化（workspace/session 二选一、paths、expiresAt、上限）；
 *   · 保存前备份旧文件，再临时文件 + rename 覆盖；
 *   · 给面板一份摘要。
 *
 * 真正的判定仍由 access.js 的 authorize()/matchesTarget() 做；本模块不决定“能不能访问”。
 */
import fs from 'node:fs'
import path from 'node:path'
import { ACCESS_FILE } from './access.js'

export const POLICY_VERSION = 1
const MAX_RULES = 100
const MAX_PATHS = 32
const MAX_PATH_LENGTH = 256
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export class PolicyValidationError extends Error {
  constructor(errors) {
    super('策略校验失败')
    this.name = 'PolicyValidationError'
    this.errors = Array.isArray(errors) ? errors : [String(errors)]
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasText(value) {
  return value !== undefined && value !== null && String(value).trim() !== ''
}

function normalizeWorkspace(value, label, errors) {
  let text = String(value || '').trim()
  if (text === '*') return '*'
  text = text.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (text.length > 1) text = text.replace(/\/+$/, '')
  if (text === '') {
    errors.push(`${label}: workspace 不能为空`)
    return null
  }
  const absolute = /^[A-Za-z]:\//.test(text) || text.startsWith('//') || text.startsWith('/')
  if (!absolute) {
    errors.push(`${label}: workspace 必须是绝对路径或 *（收到 ${text}）`)
    return null
  }
  return text
}

function normalizeSession(value, label, errors) {
  const text = String(value || '').trim()
  if (!SESSION_RE.test(text)) {
    errors.push(`${label}: session 必须是 1-128 位字母、数字、点、下划线、冒号或短横线`)
    return null
  }
  return text
}

function normalizePaths(value, label, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label}: paths 必须是非空数组`)
    return []
  }
  if (value.length > MAX_PATHS) {
    errors.push(`${label}: paths 最多 ${MAX_PATHS} 条（收到 ${value.length}）`)
    return []
  }
  const out = []
  const seen = new Set()
  for (const item of value) {
    if (typeof item !== 'string') {
      errors.push(`${label}: paths 里每一项都必须是字符串`)
      continue
    }
    let text = item.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
    while (text.startsWith('./')) text = text.slice(2)
    if (text.length > 1) text = text.replace(/\/+$/, '')
    if (text === '') {
      errors.push(`${label}: path 不能为空`)
      continue
    }
    if (text.length > MAX_PATH_LENGTH) {
      errors.push(`${label}: path 太长（>${MAX_PATH_LENGTH}）：${text.slice(0, 40)}…`)
      continue
    }
    if (text.startsWith('/') || /^[A-Za-z]:\//.test(text)) {
      errors.push(`${label}: path 必须是语料根内相对路径，不能是绝对路径：${text}`)
      continue
    }
    const segments = text.split('/')
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      errors.push(`${label}: path 不能包含 .、.. 或空段：${text}`)
      continue
    }
    if (seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

function normalizeExpiresAt(value, label, errors) {
  if (value === undefined || value === null || value === '') return null
  let parsed = null
  if (typeof value === 'number') parsed = value
  else if (typeof value === 'string') {
    const asNumber = Number(value)
    parsed = Number.isFinite(asNumber) ? asNumber : Date.parse(value)
  }
  if (!Number.isFinite(parsed) || parsed <= 0) {
    errors.push(`${label}: expiresAt 必须是毫秒时间戳或可解析的时间字符串`)
    return null
  }
  return Math.floor(parsed)
}

function normalizeRule(rule, kind, index, errors) {
  const label = `${kind}[${index}]`
  if (!isPlainObject(rule)) {
    errors.push(`${label}: 必须是对象`)
    return null
  }
  const workspace = hasText(rule.workspace)
    ? normalizeWorkspace(rule.workspace, label, errors)
    : null
  const session = hasText(rule.session)
    ? normalizeSession(rule.session, label, errors)
    : null
  if (workspace !== null && session !== null) {
    errors.push(`${label}: workspace 与 session 不能同时出现`)
    return null
  }
  if (kind === 'grants' && workspace === null && session === null) {
    errors.push(`${label}: grants 的每条规则必须指定 workspace 或 session`)
    return null
  }
  const paths = normalizePaths(rule.paths, label, errors)
  const expiresAt = normalizeExpiresAt(rule.expiresAt, label, errors)
  if (paths.length === 0) return null
  const clean = {}
  if (workspace !== null) clean.workspace = workspace
  if (session !== null) clean.session = session
  clean.paths = paths
  if (expiresAt !== null) clean.expiresAt = expiresAt
  return clean
}

/**
 * 校验并规范化来自面板/手工编辑的策略对象。
 * @throws PolicyValidationError
 */
export function normalizePolicy(input) {
  const errors = []
  const warnings = []
  if (!isPlainObject(input)) throw new PolicyValidationError(['策略必须是 JSON 对象'])
  const defaultAction = input.default === undefined ? 'deny' : String(input.default)
  if (defaultAction !== 'allow' && defaultAction !== 'deny') {
    errors.push("default 只能是 'allow' 或 'deny'")
  }
  const readRules = (key, kind) => {
    const value = input[key]
    if (value === undefined || value === null) return []
    if (!Array.isArray(value)) {
      errors.push(`${key} 必须是数组`)
      return []
    }
    if (value.length > MAX_RULES) {
      errors.push(`${key} 最多 ${MAX_RULES} 条（收到 ${value.length}）`)
      return []
    }
    const out = []
    value.forEach((rule, index) => {
      const clean = normalizeRule(rule, kind, index, errors)
      if (clean !== null) out.push(clean)
    })
    return out
  }
  const grants = readRules('grants', 'grants')
  const deny = readRules('deny', 'deny')
  if (input.version !== undefined && Number(input.version) !== POLICY_VERSION) {
    warnings.push(`version 已按 ${POLICY_VERSION} 写入`)
  }
  if (errors.length > 0) throw new PolicyValidationError(errors)
  return {
    policy: { version: POLICY_VERSION, default: defaultAction, grants, deny },
    warnings,
  }
}

/** 读策略文件；不存在/损坏都不抛错，由调用方决定怎么提示。 */
export function readPolicy(dshHome) {
  const accessFile = path.join(dshHome, ACCESS_FILE)
  let stat = null
  try { stat = fs.statSync(accessFile) } catch { /* 不存在 */ }
  if (stat === null) {
    return { accessFile, exists: false, policy: null, error: null, mtimeMs: null }
  }
  try {
    const policy = JSON.parse(fs.readFileSync(accessFile, 'utf8'))
    if (!isPlainObject(policy)) throw new Error('策略文件顶层不是对象')
    return { accessFile, exists: true, policy, error: null, mtimeMs: stat.mtimeMs }
  } catch (error) {
    return {
      accessFile,
      exists: true,
      policy: null,
      error: error instanceof Error ? error.message : String(error),
      mtimeMs: stat.mtimeMs,
    }
  }
}

/** 面板用的策略摘要；损坏时保留 error 让 UI 显示，而不是伪装成空策略。 */
export function policySummary(dshHome) {
  const read = readPolicy(dshHome)
  const policy = read.policy || {}
  return {
    accessFile: read.accessFile,
    exists: read.exists,
    default: policy.default === 'allow' ? 'allow' : 'deny',
    grants: Array.isArray(policy.grants) ? policy.grants : [],
    deny: Array.isArray(policy.deny) ? policy.deny : [],
    error: read.error,
    mtimeMs: read.mtimeMs,
  }
}

function backupStamp() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 校验并保存策略；保存前备份旧文件，用临时文件 + rename 覆盖。
 * @throws PolicyValidationError
 */
export function savePolicy(dshHome, input) {
  const { policy } = normalizePolicy(input)
  const accessFile = path.join(dshHome, ACCESS_FILE)
  fs.mkdirSync(path.dirname(accessFile), { recursive: true })

  let backup = null
  if (fs.existsSync(accessFile)) {
    const backupDir = path.join(dshHome, 'backups')
    fs.mkdirSync(backupDir, { recursive: true })
    backup = path.join(backupDir, `corpus-access-${backupStamp()}.json`)
    fs.copyFileSync(accessFile, backup)
  }

  const text = JSON.stringify(policy, null, 2) + '\n'
  const temp = `${accessFile}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(temp, text, 'utf8')
  try {
    fs.renameSync(temp, accessFile)
  } catch (error) {
    // Windows 上极少数情况下 rename 覆盖会失败；退化为先删再改名（已有备份）。
    try { fs.rmSync(accessFile, { force: true }) } catch { /* 继续尝试 */ }
    try {
      fs.renameSync(temp, accessFile)
    } catch (retryError) {
      try { fs.rmSync(temp, { force: true }) } catch { /* 清理失败不掩盖原错误 */ }
      throw retryError
    }
  }
  return { policy, accessFile, backup }
}
