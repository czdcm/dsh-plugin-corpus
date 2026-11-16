/**
 * dsh-plugin-corpus — 新建集合的「最小自动授权」（v1.6）。
 *
 * 场景：用户说「新建合集 X，把这些文件放进去」，而 X 还不存在、当前 session/workspace
 * 也没有任何 grant。插件在**只针对该集合**的前提下自动补一条最小授权，
 * 并写审计记录；其余情况（集合已存在、显式 deny、策略损坏）一律不自动放行。
 *
 * 安全边界：
 *   · default 保持 deny；绝不写 '*'、绝不批量授权；
 *   · 只对本次目标集合生效，不做继承/透传；
 *   · 已有显式 deny 命中时拒绝自动授权；
 *   · 授权通过 savePolicy()（带备份）落盘，不手改文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { ACCESS_FILE, policyAllowsTarget, policyDeniesTarget, readPolicySafe } from './access.js'
import { isValidCollectionName, collectionNameError } from './collection-name.js'
import { normalizePolicy, savePolicy } from './policy.js'

export const AUTO_GRANT_AUDIT = path.join('.corpus', 'audit', 'auto-grant.jsonl')

function auditPath(root) {
  return path.join(root, AUTO_GRANT_AUDIT)
}

/**
 * 判定是否可以对某集合自动授权。
 * @returns {{ok: true, subject: object} | {ok: false, reason: string}}
 */
export function canAutoGrant({ dshHome, root, subject, collection }) {
  const name = String(collection || '').trim()
  if (!isValidCollectionName(name)) return { ok: false, reason: collectionNameError(name) }
  let collectionDir = null
  try { collectionDir = path.join(root, name) } catch { return { ok: false, reason: '集合路径非法' } }
  if (fs.existsSync(collectionDir)) {
    return { ok: false, reason: '集合已存在，需在「语料权限」里人工授权' }
  }
  const read = readPolicySafe(dshHome)
  if (read.error !== null) return { ok: false, reason: `策略文件损坏：${read.error}` }
  const policy = read.policy
  if (policy !== null) {
    if (policyDeniesTarget(policy, subject, name)) {
      return { ok: false, reason: '存在显式 deny，需用户处理' }
    }
    if (policyAllowsTarget(policy, subject, name)) {
      return { ok: false, reason: '已有授权但判定未通过（可能已过期），需人工检查' }
    }
  }
  return { ok: true, subject }
}

/**
 * 给「调用者 + 目标集合」补一条最小 grant，并写审计。
 * @returns {{rule: object, backup: string|null, accessFile: string, auditFile: string, auditError: string|null}}
 */
export function grantNewCollection({ dshHome, root, subject, collection, tool }) {
  const name = String(collection || '').trim()
  const read = readPolicySafe(dshHome)
  const base = read.policy !== null
    ? JSON.parse(JSON.stringify(read.policy))
    : { version: 1, default: 'deny', grants: [], deny: [] }
  if (!Array.isArray(base.grants)) base.grants = []
  if (!Array.isArray(base.deny)) base.deny = []
  if (!base.default) base.default = 'deny'

  const session = subject && typeof subject.session === 'string' ? subject.session.trim() : ''
  const workspace = subject && typeof subject.workspace === 'string' ? subject.workspace : ''
  const rule = session !== ''
    ? { session, paths: [name] }
    : { workspace: workspace.replace(/\\/g, '/').replace(/\/+$/, ''), paths: [name] }

  base.grants.push(rule)
  // 先过一遍校验，避免把坏规则写进策略文件（保存前 savePolicy 还会再校验一次）。
  normalizePolicy(base)
  const saved = savePolicy(dshHome, base)

  const auditFile = auditPath(root)
  let auditError = null
  try {
    fs.mkdirSync(path.dirname(auditFile), { recursive: true })
    fs.appendFileSync(auditFile, JSON.stringify({
      at: new Date().toISOString(),
      tool: String(tool || ''),
      session,
      workspace,
      collection: name,
      rule,
      accessFile: saved.accessFile,
      backup: saved.backup,
    }) + '\n', 'utf8')
  } catch (error) {
    auditError = error instanceof Error ? error.message : String(error)
  }
  return {
    rule,
    backup: saved.backup,
    accessFile: saved.accessFile,
    auditFile,
    auditError,
  }
}

export { ACCESS_FILE }
