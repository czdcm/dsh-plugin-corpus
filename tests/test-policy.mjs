/**
 * dsh-plugin-corpus v1.2 策略 / 右栏权限验收测试。
 *
 * 自包含：只在 os.tmpdir() 下造临时 home（策略文件）与合成语料根，不读写 ~/.dsh；
 * 结束（含失败）清理临时目录。
 *
 * 覆盖：
 *   · policy.normalizePolicy —— 合法规范化（workspace / paths / expiresAt / session）
 *     与各类非法输入（default、主体、绝对路径/`..`、上限、过期时间）；
 *   · policy.savePolicy / readPolicy / policySummary —— 首次无备份、二次备份旧文件、
 *     原子覆盖（无临时文件残留）、损坏 JSON 的 error、校验失败不写盘；
 *   · access.ruleExpiresAt / ruleExpired 与 authorize 的过期语义
 *     （过期 grant 不生效、未到期 grant 生效、过期 deny 不阻塞、未过期 deny 仍生效）；
 *   · panel.createPanelRoutes —— 18 条路由（v1.3 新增 /import/targets、/import、/import/status、
 *     /originals、/original、/thumbnail）、GET /access（session 解析/fallback/未知）、
 *     GET /policy、POST /policy（400 errors / 200 + backup + 立即生效 / 直接传策略对象）、
 *     同源 403、方法 405。
 *
 * 运行（DSH 自带 Node 24）：
 *   & "…\dependencies\node\bin\node.exe" tests\test-policy.mjs
 * 输出：PASS 行 + 末尾「全部通过: N 项」；失败抛错、退出码非 0。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { authorize, normalize, ruleExpired, ruleExpiresAt } from '../plugin/lib/access.js'
import { collectionNames } from '../plugin/lib/engine.js'
import { createPanelRoutes, PANEL_PREFIX } from '../plugin/lib/panel.js'
import {
  POLICY_VERSION,
  PolicyValidationError,
  normalizePolicy,
  policySummary,
  readPolicy,
  savePolicy,
} from '../plugin/lib/policy.js'

let pass = 0
const ok = (label) => { pass++; console.log('  PASS ' + label) }
const assert = (condition, message) => { if (!condition) throw new Error('ASSERT: ' + message) }

function expectPolicyError(fn, label) {
  let error = null
  try { fn() } catch (caught) { error = caught }
  if (error === null) throw new Error(`应当被拒绝却成功了：${label}`)
  if (!(error instanceof PolicyValidationError)) {
    throw new Error(`拒绝类型不对（${label}）：期望 PolicyValidationError，实际 ${error && error.name}`)
  }
  if (!Array.isArray(error.errors) || error.errors.length === 0) {
    throw new Error(`拒绝原因（${label}）应带非空 errors[]`)
  }
  return error
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-policy-'))
const home = path.join(tmp, 'home')
const root = path.join(tmp, 'corpus')

try {
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(path.join(root, 'alpha'), { recursive: true })
  fs.mkdirSync(path.join(root, 'beta'), { recursive: true })
  const accessFile = path.join(home, 'corpus-access.json')

  // -------------------------------------------------------------------------
  // 1. normalizePolicy：合法输入规范化
  // -------------------------------------------------------------------------
  const future = Date.now() + 60 * 60 * 1000
  const iso = '2030-01-02T03:04:05.000Z'
  const normalized = normalizePolicy({
    version: 1,
    default: 'deny',
    grants: [
      {
        workspace: 'C:\\Users\\me\\Desktop\\DSH\\IT\\',
        paths: ['linux-kernel', './dsh-docs//', 'linux-kernel/', 'linux-kernel\\networking.md'],
        expiresAt: future,
        note: '这个字段应被丢弃',
      },
      { session: 'session-test-1', paths: ['alpha/a.md'], expiresAt: iso },
    ],
    deny: [{ paths: ['**/private/**'] }],
  })
  assert(normalized.policy.version === POLICY_VERSION && normalized.policy.default === 'deny', 'version=1 / default=deny')
  assert(normalized.policy.grants.length === 2 && normalized.policy.deny.length === 1, '规则数量')
  assert(normalized.policy.grants[0].workspace === 'C:/Users/me/Desktop/DSH/IT', 'workspace 反斜杠/尾斜杠规范化：' + normalized.policy.grants[0].workspace)
  assert(normalized.policy.grants[0].paths.join(',') === 'linux-kernel,dsh-docs,linux-kernel/networking.md', 'paths 规范化/去重：' + normalized.policy.grants[0].paths.join(','))
  assert(Number.isInteger(normalized.policy.grants[0].expiresAt), 'expiresAt 保存为整数毫秒')
  assert(normalized.policy.grants[1].expiresAt === Date.parse(iso), 'ISO 字符串 expiresAt 转毫秒')
  assert(!('note' in normalized.policy.grants[0]), '未知字段被丢弃')
  assert(normalized.policy.deny[0].workspace === undefined && normalized.policy.deny[0].session === undefined, 'deny 无主体=全局规则')
  assert(normalized.warnings.length === 0, '合法输入无警告')
  ok('normalizePolicy：workspace / paths / expiresAt 规范化')

  const minimal = normalizePolicy({ grants: [{ workspace: '*', paths: ['public'] }] })
  assert(minimal.policy.version === POLICY_VERSION && minimal.policy.default === 'deny', '缺省 default=deny / version=1')
  assert(minimal.policy.grants[0].workspace === '*' && minimal.policy.grants[0].paths[0] === 'public', '通配 workspace + paths')
  assert(minimal.policy.deny.length === 0, '缺省 deny=[]')
  ok('normalizePolicy：缺省 default / version 固定 1 / 通配 workspace')

  const versioned = normalizePolicy({ version: 2, default: 'allow', grants: [{ workspace: 'C:/W', paths: ['a'] }] })
  assert(versioned.policy.version === 1 && versioned.policy.default === 'allow', 'version 不匹配按 1 写；default=allow 可用')
  assert(versioned.warnings.length === 1 && versioned.warnings[0].includes('version'), 'version 不匹配给警告：' + JSON.stringify(versioned.warnings))
  ok('normalizePolicy：version 只警告，default=allow 接受')

  // -------------------------------------------------------------------------
  // 2. normalizePolicy：非法输入拒绝
  // -------------------------------------------------------------------------
  const grants100 = Array.from({ length: 101 }, () => ({ workspace: 'C:/x', paths: ['alpha'] }))
  const paths33 = Array.from({ length: 33 }, (_item, index) => 'p' + index)
  const rejects = [
    ['default 非法', { default: 'maybe' }],
    ['grants 无主体', { default: 'deny', grants: [{ paths: ['alpha'] }] }],
    ['grants 空白主体', { default: 'deny', grants: [{ workspace: '   ', paths: ['alpha'] }] }],
    ['workspace+session 同时出现', { default: 'deny', grants: [{ workspace: 'C:/x', session: 'session-a', paths: ['alpha'] }] }],
    ['deny 同时出现 workspace+session', { default: 'deny', deny: [{ workspace: 'C:/x', session: 'session-a', paths: ['alpha'] }] }],
    ['相对 workspace', { default: 'deny', grants: [{ workspace: 'relative/path', paths: ['alpha'] }] }],
    ['绝对 path', { default: 'deny', grants: [{ workspace: 'C:/x', paths: ['/abs/path'] }] }],
    ['盘符 path', { default: 'deny', grants: [{ workspace: 'C:/x', paths: ['C:/secret'] }] }],
    ['path 含 ..', { default: 'deny', grants: [{ workspace: 'C:/x', paths: ['a/../b'] }] }],
    ['path 含 .', { default: 'deny', grants: [{ workspace: 'C:/x', paths: ['a/./b'] }] }],
    ['paths 空数组', { default: 'deny', grants: [{ workspace: 'C:/x', paths: [] }] }],
    ['path 不是字符串', { default: 'deny', grants: [{ workspace: 'C:/x', paths: [123] }] }],
    ['path 过长', { default: 'deny', grants: [{ workspace: 'C:/x', paths: ['a'.repeat(257)] }] }],
    ['paths 超过 32 条', { default: 'deny', grants: [{ workspace: 'C:/x', paths: paths33 }] }],
    ['非法 session', { default: 'deny', grants: [{ session: 'bad session id!', paths: ['alpha'] }] }],
    ['session 以点开头', { default: 'deny', grants: [{ session: '.session', paths: ['alpha'] }] }],
    ['expiresAt 非时间', { default: 'deny', grants: [{ workspace: 'C:/x', paths: ['alpha'], expiresAt: 'not-a-date' }] }],
    ['expiresAt 为 0', { default: 'deny', grants: [{ workspace: 'C:/x', paths: ['alpha'], expiresAt: 0 }] }],
    ['expiresAt 为负数', { default: 'deny', grants: [{ workspace: 'C:/x', paths: ['alpha'], expiresAt: -5 }] }],
    ['expiresAt 为布尔', { default: 'deny', grants: [{ workspace: 'C:/x', paths: ['alpha'], expiresAt: true }] }],
    ['grants 不是数组', { default: 'deny', grants: 'not-array' }],
    ['deny 不是数组', { default: 'deny', deny: 'not-array' }],
    ['规则不是对象', { default: 'deny', grants: [null] }],
    ['grants 超过 100 条', { default: 'deny', grants: grants100 }],
    ['deny 超过 100 条', { default: 'deny', deny: grants100 }],
  ]
  let rejected = 0
  for (const [label, input] of rejects) {
    expectPolicyError(() => normalizePolicy(input), label)
    rejected++
  }
  assert(rejected === rejects.length, `应拒绝 ${rejects.length} 组，实际 ${rejected}`)
  ok('normalizePolicy：拒绝 ' + rejects.length + ' 组非法规则（default/主体/paths/上限/过期时间）')

  let topErrors = 0
  for (const bad of [null, [], 'x', 42]) {
    try { normalizePolicy(bad) } catch (error) {
      assert(error instanceof PolicyValidationError && error.errors.length > 0, '入口形状错误应是 PolicyValidationError')
      topErrors++
    }
  }
  assert(topErrors === 4, '顶层非对象应全部拒绝')
  ok('normalizePolicy：顶层非对象拒绝')

  const specific = expectPolicyError(
    () => normalizePolicy({ default: 'deny', grants: [{ workspace: 'C:/x', paths: ['../a'] }] }),
    '错误信息内容',
  )
  assert(specific.errors.some((message) => message.includes('path')), '错误信息应指出 path 问题：' + JSON.stringify(specific.errors))
  ok('PolicyValidationError：errors[] 带可读原因')

  // -------------------------------------------------------------------------
  // 3. savePolicy / readPolicy / policySummary
  // -------------------------------------------------------------------------
  const before = readPolicy(home)
  assert(before.exists === false && before.policy === null && before.error === null && before.mtimeMs === null, '未保存时 exists=false / policy=null / error=null / mtimeMs=null')
  assert(before.accessFile === accessFile, 'accessFile 路径')
  ok('readPolicy：文件不存在时返回空读结果')

  const first = savePolicy(home, normalized.policy)
  assert(first.backup === null, '首次保存不应有备份（实际 ' + first.backup + '）')
  assert(fs.existsSync(accessFile), '首次保存写入策略文件')
  const firstText = fs.readFileSync(accessFile, 'utf8')
  assert(JSON.parse(firstText).version === 1, '写入文件 version=1')
  const loaded = readPolicy(home)
  assert(loaded.exists === true && loaded.policy && loaded.policy.grants.length === 2 && loaded.error === null, 'readPolicy 读回策略')
  assert(typeof loaded.mtimeMs === 'number' && loaded.mtimeMs > 0, 'readPolicy 带 mtimeMs')
  const summary = policySummary(home)
  assert(summary.accessFile === accessFile && summary.exists === true && summary.error === null, 'policySummary 基本字段')
  assert(summary.default === 'deny' && summary.grants.length === 2 && summary.deny.length === 1, 'policySummary default/grants/deny')
  assert(typeof summary.mtimeMs === 'number', 'policySummary 带 mtimeMs')
  ok('savePolicy 首次保存（无备份）+ readPolicy/policySummary')

  const previousText = firstText
  const second = savePolicy(home, { ...normalized.policy, default: 'allow' })
  assert(typeof second.backup === 'string' && fs.existsSync(second.backup), '第二次保存应备份旧文件：' + second.backup)
  const backupPolicy = JSON.parse(fs.readFileSync(second.backup, 'utf8'))
  assert(backupPolicy.default === 'deny' && backupPolicy.grants.length === 2, '备份内容是保存前的旧策略')
  assert(readPolicy(home).policy.default === 'allow', '覆盖后读到新策略')
  const leftovers = fs.readdirSync(home).filter((name) => name.includes('.tmp-'))
  assert(leftovers.length === 0, '保存后不应残留临时文件：' + leftovers.join(','))
  assert(previousText !== fs.readFileSync(accessFile, 'utf8'), '文件内容确实被覆盖')
  ok('savePolicy：二次保存备份旧文件 + 原子覆盖无临时残留')

  const beforeInvalid = fs.readFileSync(accessFile, 'utf8')
  expectPolicyError(() => savePolicy(home, { default: 'nope' }), '保存非法策略')
  assert(fs.readFileSync(accessFile, 'utf8') === beforeInvalid, '校验失败不应改写策略文件')
  ok('savePolicy：校验失败不写盘')

  const versionedSave = savePolicy(home, { version: 9, default: 'deny', grants: [{ workspace: 'C:/V', paths: ['alpha'] }], deny: [] })
  assert(JSON.parse(fs.readFileSync(accessFile, 'utf8')).version === 1, '保存时 version 固定为 1')
  assert(versionedSave.policy.version === 1, '返回的 policy.version=1')
  ok('savePolicy：version 统一写 1')

  // -------------------------------------------------------------------------
  // 4. 损坏的策略文件
  // -------------------------------------------------------------------------
  fs.writeFileSync(accessFile, '{ this is not json', 'utf8')
  const broken = readPolicy(home)
  assert(broken.exists === true && broken.policy === null && typeof broken.error === 'string' && broken.error !== '', '损坏 JSON：exists=true / policy=null / error 非空')
  assert(typeof broken.mtimeMs === 'number', '损坏 JSON 仍带 mtimeMs')
  const brokenSummary = policySummary(home)
  assert(brokenSummary.exists === true && brokenSummary.default === 'deny' && brokenSummary.grants.length === 0 && brokenSummary.deny.length === 0, '损坏 JSON 的摘要回落为空策略')
  assert(typeof brokenSummary.error === 'string' && brokenSummary.error !== '', '摘要保留 error 供 UI 显示')
  ok('readPolicy/policySummary：损坏 JSON 返回 error 而不是伪装成空策略')

  const recovered = savePolicy(home, { default: 'deny', grants: [{ workspace: 'C:/R', paths: ['alpha'] }], deny: [] })
  assert(typeof recovered.backup === 'string' && fs.existsSync(recovered.backup), '损坏文件也会被备份后再覆盖')
  const afterRecover = readPolicy(home)
  assert(afterRecover.exists === true && afterRecover.error === null && afterRecover.policy.grants.length === 1, '覆盖后恢复正常策略')
  ok('savePolicy：可修复损坏的策略文件（先备份）')

  // -------------------------------------------------------------------------
  // 5. 过期语义：ruleExpiresAt / ruleExpired / authorize
  // -------------------------------------------------------------------------
  assert(ruleExpiresAt({ expiresAt: 1234.9 }) === 1234.9, 'number 原样返回')
  assert(ruleExpiresAt({ expiresAt: iso }) === Date.parse(iso), 'ISO 字符串转毫秒')
  assert(ruleExpiresAt({ expiresAt: '1700000000000' }) === null, '纯数字字符串不是可解析时间 → null（policy 保存时会转 number）')
  assert(ruleExpiresAt({}) === null && ruleExpiresAt({ expiresAt: null }) === null && ruleExpiresAt({ expiresAt: '' }) === null, '缺省/null/空串 → null')
  assert(ruleExpiresAt({ expiresAt: 'nope' }) === null && ruleExpiresAt(null) === null, '非法值/null 规则 → null')
  assert(ruleExpired({ expiresAt: 1000 }, 1000) === true, '到期边界 now>=expiresAt 视为过期')
  assert(ruleExpired({ expiresAt: 1000 }, 999) === false, '未到期不判过期')
  assert(ruleExpired({}, Date.now()) === false && ruleExpired(null) === false, '无 expiresAt 永不过期')
  ok('ruleExpiresAt / ruleExpired：数字、ISO、边界与缺省')

  const now = Date.now()
  savePolicy(home, {
    version: 1,
    default: 'deny',
    grants: [
      { workspace: 'C:/WS', paths: ['alpha'], expiresAt: now - 1000 },
      { session: 'session-live', paths: ['alpha/a.md'], expiresAt: now + 60000 },
    ],
    deny: [{ paths: ['alpha/a.md'], expiresAt: now - 5000 }],
  })
  const expiredScope = authorize(home, { workspace: 'C:/WS', session: 'other' }, collectionNames(root))
  assert(expiredScope.allowedCollections.length === 0, '过期 grant 不生效，实际 ' + expiredScope.allowedCollections.join(','))
  const futureScope = authorize(home, { workspace: 'C:/OTHER', session: 'session-live' }, collectionNames(root))
  assert(futureScope.allowedCollections.join(',') === 'alpha', '未到期 session grant 生效')
  assert(futureScope.allow('alpha/a.md') === true, '过期 deny 不阻塞')
  ok('authorize：过期 grant 不生效、未到期 grant 生效、过期 deny 不阻塞')

  savePolicy(home, {
    version: 1,
    default: 'deny',
    grants: [{ session: 'session-live', paths: ['alpha/a.md'], expiresAt: now + 60000 }],
    deny: [{ paths: ['alpha/a.md'] }],
  })
  const deniedScope = authorize(home, { workspace: 'C:/OTHER', session: 'session-live' }, collectionNames(root))
  assert(deniedScope.allow('alpha/a.md') === false, '未过期的 deny 仍应阻塞')
  ok('authorize：未过期的 deny 仍然优先')

  // -------------------------------------------------------------------------
  // 6. 面板：8 条路由 + /access + /policy
  // -------------------------------------------------------------------------
  savePolicy(home, {
    version: 1,
    default: 'deny',
    grants: [
      { workspace: 'C:/WS', paths: ['alpha'] },
      { workspace: 'C:/FB', paths: ['beta'] },
    ],
    deny: [{ paths: ['**/private/**'] }],
  })
  const fakeJobs = {
    start: () => ({ started: false, job: null }),
    status: () => ({ active: null, recent: [] }),
  }
  const sessionLookup = (id) => {
    if (id === 'boom') throw new Error('session lookup failed')
    if (id === 'session-1') return { id: 'session-1', workspace: 'C:/WS' }
    return null
  }
  const routes = createPanelRoutes({ root, dshHome: home, jobs: fakeJobs, sessionLookup })
  const byPath = new Map(routes.map((route) => [route.path, route]))

  assert(routes.length === 18, '面板应有 18 条路由，实际 ' + routes.length)
  assert(routes.every((route) => route.kind === 'exact' && route.path.startsWith(PANEL_PREFIX)), '路由应为 exact 且带统一前缀')
  for (const suffix of ['overview', 'files', 'search', 'read', 'reindex', 'status', 'policy', 'access', 'import/targets', 'import', 'import/status', 'app-icon', 'settings', 'settings/root', 'settings/open', 'gallery', 'delete']) {
    assert(byPath.has(PANEL_PREFIX + '/' + suffix), '缺少路由 ' + suffix)
  }
  ok('面板路由表：18 条 exact（v1.2 /access + v1.3 /import/*）')

  const invoke = (method, url, body, headers = {}) => new Promise((resolve, reject) => {
    const route = byPath.get(url.split('?')[0])
    if (!route) return reject(new Error('没有路由 ' + url))
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = Readable.from(chunks)
    req.method = method
    req.url = url
    req.headers = { host: '127.0.0.1:1234', ...headers }
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) { this.headers[name] = value },
      end(text) {
        let parsed = null
        try { parsed = text ? JSON.parse(text) : null } catch (error) { reject(error); return }
        resolve({ status: this.statusCode, body: parsed })
      },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })

  const accessRes = await invoke('GET', PANEL_PREFIX + '/access?session=session-1')
  assert(accessRes.status === 200 && accessRes.body.ok === true, '/access 200: ' + JSON.stringify(accessRes.body))
  assert(accessRes.body.sessionId === 'session-1', '/access sessionId')
  assert(accessRes.body.workspace === 'C:/WS', '/access workspace: ' + accessRes.body.workspace)
  assert(accessRes.body.workspaceKey === normalize('C:/WS'), '/access workspaceKey: ' + accessRes.body.workspaceKey)
  assert(accessRes.body.effectiveCollections.join(',') === 'alpha', '/access effectiveCollections: ' + accessRes.body.effectiveCollections)
  assert(Array.isArray(accessRes.body.collections) && accessRes.body.collections.length === 2, '/access collections 候选')
  for (const collection of accessRes.body.collections) {
    assert(typeof collection.name === 'string' && typeof collection.backend === 'string' && typeof collection.docs === 'number', '/access collections 字段 {name,backend,docs}')
  }
  assert(accessRes.body.policy.exists === true && accessRes.body.policy.grants.length === 2 && accessRes.body.policy.deny.length === 1, '/access policy 摘要')
  ok('GET /access：session 解析 workspace / workspaceKey / effectiveCollections / collections / policy')

  const fallback = await invoke('GET', PANEL_PREFIX + '/access?session=ghost&workspace=C:/FB')
  assert(fallback.status === 200 && fallback.body.ok === true, '/access fallback 200')
  assert(fallback.body.sessionId === 'ghost' && fallback.body.workspace === 'C:/FB', '/access 未知 session 用 fallback workspace')
  assert(fallback.body.effectiveCollections.join(',') === 'beta', '/access fallback effectiveCollections: ' + fallback.body.effectiveCollections)

  const lookupThrows = await invoke('GET', PANEL_PREFIX + '/access?session=boom&workspace=C:/FB')
  assert(lookupThrows.status === 200 && lookupThrows.body.workspace === 'C:/FB', 'sessionLookup 抛错时不 500，回退 workspace')
  ok('GET /access：未知 session / lookup 抛错时回退 workspace')

  const nothing = await invoke('GET', PANEL_PREFIX + '/access?session=ghost')
  assert(nothing.status === 200 && nothing.body.workspace === '' && nothing.body.effectiveCollections.length === 0, '/access 无 session 无 workspace → 空范围')
  ok('GET /access：未知 session 且无 workspace 时有效集合为空')

  const policyGet = await invoke('GET', PANEL_PREFIX + '/policy')
  assert(policyGet.status === 200 && policyGet.body.ok === true, '/policy GET 200')
  assert(policyGet.body.accessFile === accessFile && policyGet.body.exists === true, '/policy accessFile/exists')
  assert(policyGet.body.default === 'deny' && policyGet.body.grants.length === 2 && policyGet.body.deny.length === 1, '/policy default/grants/deny')
  assert(policyGet.body.error === null && typeof policyGet.body.mtimeMs === 'number', '/policy error/mtimeMs')
  ok('GET /policy：返回摘要（含 mtimeMs）')

  const badSave = await invoke('POST', PANEL_PREFIX + '/policy', { policy: { default: 'maybe' } })
  assert(badSave.status === 400 && badSave.body.ok === false, 'POST /policy 非法策略应 400')
  assert(badSave.body.error === '策略校验失败' && Array.isArray(badSave.body.errors) && badSave.body.errors.length > 0, 'POST /policy 400 带 errors[]')
  assert(readPolicy(home).policy.grants.length === 2, '400 时策略文件未被改写')
  ok('POST /policy：校验失败 400 + errors[]，文件不变')

  const nextPolicy = {
    version: 1,
    default: 'deny',
    grants: [
      { workspace: 'C:/WS', paths: ['alpha'] },
      { session: 'session-1', paths: ['beta/b.md'], expiresAt: future },
    ],
    deny: [{ paths: ['**/private/**'] }],
  }
  const saved = await invoke('POST', PANEL_PREFIX + '/policy', { policy: nextPolicy })
  assert(saved.status === 200 && saved.body.ok === true, 'POST /policy 合法策略 200: ' + JSON.stringify(saved.body))
  assert(saved.body.accessFile === accessFile, 'POST /policy accessFile')
  assert(typeof saved.body.backup === 'string' && fs.existsSync(saved.body.backup), 'POST /policy 返回并写入备份: ' + saved.body.backup)
  assert(saved.body.policy.grants.length === 2 && saved.body.policy.default === 'deny', 'POST /policy 返回摘要')
  const backupContent = JSON.parse(fs.readFileSync(saved.body.backup, 'utf8'))
  assert(backupContent.grants.length === 2 && backupContent.grants[0].workspace === 'C:/WS', '备份内容是保存前的策略')

  const accessAfterSave = await invoke('GET', PANEL_PREFIX + '/access?session=session-1')
  assert(accessAfterSave.body.effectiveCollections.sort().join(',') === 'alpha,beta', '保存后 /access 立即反映新会话规则: ' + accessAfterSave.body.effectiveCollections)
  const savedPolicy = readPolicy(home).policy
  const sessionRule = savedPolicy.grants.find((rule) => rule.session === 'session-1')
  assert(sessionRule && sessionRule.expiresAt === Math.floor(future), '保存的会话规则保留 expiresAt')
  ok('POST /policy：保存 + 备份 + /access 立即反映')

  const direct = await invoke('POST', PANEL_PREFIX + '/policy', {
    version: 1,
    default: 'allow',
    grants: [{ workspace: 'C:/WS', paths: ['alpha'] }],
    deny: [],
  })
  assert(direct.status === 200 && direct.body.ok === true && direct.body.policy.default === 'allow', 'POST /policy 接受直接策略对象')
  assert(readPolicy(home).policy.default === 'allow', '直接对象也写入文件')
  ok('POST /policy：兼容直接传策略对象（无 policy 包装）')

  const methodAccess = await invoke('POST', PANEL_PREFIX + '/access', {})
  const methodPolicy = await invoke('PUT', PANEL_PREFIX + '/policy', {})
  assert(methodAccess.status === 405 && methodPolicy.status === 405, 'POST /access 与 PUT /policy 应 405')
  ok('面板方法限制：/access 只 GET、/policy 只 GET/POST')

  const crossAccess = await invoke('GET', PANEL_PREFIX + '/access?session=session-1', undefined, { origin: 'http://evil.test' })
  const crossPolicy = await invoke('POST', PANEL_PREFIX + '/policy', { policy: nextPolicy }, { origin: 'http://evil.test' })
  assert(crossAccess.status === 403 && crossPolicy.status === 403, '跨站 /access 与 /policy 应 403')
  ok('面板同源校验：/access 与 POST /policy 跨站 403')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('\n全部通过: ' + pass + ' 项')
