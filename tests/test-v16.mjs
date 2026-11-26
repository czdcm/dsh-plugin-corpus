/**
 * v1.6 验收：ZIP 重写/Office 瘦身、公式白名单、OCR 引擎与预算、新建集合自动授权。
 * 运行：node tests/test-v16.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readZip, rewriteZip, writeZip } from '../plugin/lib/zip.js'
import { slimOfficeFile } from '../plugin/lib/extract.js'
import { latexifyFormulaLines } from '../plugin/lib/formulas.js'
import { ocrTimeoutMs, rapidOcrAvailable, resolveOcrEngine } from '../plugin/lib/pdf.js'
import { AUTO_GRANT_AUDIT, canAutoGrant, grantNewCollection } from '../plugin/lib/autogrant.js'
import { authorize } from '../plugin/lib/access.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const tmpRoots = []

function tempDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `corpus-v16-${tag}-`))
  tmpRoots.push(dir)
  return dir
}

function ok(name) {
  console.log(`  OK ${name}`)
}

try {
  // 1. ZIP 重写：跳过媒体条目，其余条目原样可读。
  {
    const big = Buffer.alloc(200 * 1024, 7)
    const zip = writeZip({
      '[Content_Types].xml': '<Types/>',
      'ppt/presentation.xml': '<p:sldIdLst/>',
      'ppt/media/video.mp4': big,
      'ppt/fonts/font1.fntdata': big,
      'ppt/slides/slide1.xml': '<p:sld/>',
    })
    const rewritten = rewriteZip(zip, { skip: (name) => /\.(mp4|fntdata)$/i.test(name) })
    assert.equal(rewritten.skipped, 2, '应跳过 2 个媒体/字体条目')
    assert.ok(rewritten.buffer.length < zip.length, '重写后应更小')
    const entries = readZip(rewritten.buffer)
    assert.ok(entries.has('ppt/presentation.xml') && entries.has('ppt/slides/slide1.xml'), '正文条目应保留')
    assert.ok(!entries.has('ppt/media/video.mp4') && !entries.has('ppt/fonts/font1.fntdata'), '媒体/字体应被跳过')
    ok('ZIP 重写保留正文、跳过媒体')
  }

  // 2. Office 瘦身：超过上限时生成可读副本，原文件不动。
  {
    const dir = tempDir('slim')
    const source = path.join(dir, 'big.pptx')
    const big = Buffer.alloc(300 * 1024, 3)
    fs.writeFileSync(source, writeZip({
      '[Content_Types].xml': '<Types/>',
      'ppt/presentation.xml': '<p:sldIdLst/>',
      'ppt/media/media2.mp4': big,
      'ppt/embeddings/oleObject1.bin': big,
      'ppt/slides/slide1.xml': '<p:sld/>',
    }))
    const before = fs.statSync(source).size
    const slim = await slimOfficeFile(source, before - 1)
    assert.ok(slim.removed >= 2, '应至少跳过 2 个条目')
    assert.ok(fs.existsSync(slim.path), '瘦身副本应存在')
    assert.ok(fs.statSync(slim.path).size < before, '瘦身副本应更小')
    assert.equal(fs.statSync(source).size, before, '原文件不应被修改')
    const entries = readZip(fs.readFileSync(slim.path))
    assert.ok(entries.has('ppt/presentation.xml'), '瘦身副本应可读')
    fs.rmSync(slim.tempDir, { recursive: true, force: true })
    ok('Office 超限自动瘦身（原文件不变）')
  }

  // 3. 公式白名单：Office 对象摘要行不得被包成 $$...$$。
  {
    const summary = '- 对象：文本框 5；连接线 14（位置 110.5pt,428.75pt 尺寸 141.75pt×0cm）'
    assert.equal(latexifyFormulaLines(summary), summary, '对象摘要行不应变成公式')
    const slide = '### Slide 3：进度条'
    assert.equal(latexifyFormulaLines(slide), slide, 'Slide 标题不应变成公式')
    const formula = '∑F = m×a ≤ 100'
    assert.ok(latexifyFormulaLines(formula).includes('$$'), '真正的公式仍应被包裹')
    ok('公式白名单：对象摘要行不 LaTeX 化')
  }

  // 4. OCR 预算与引擎选择。
  {
    assert.equal(ocrTimeoutMs(1), 15 * 60 * 1000, '单页也应给足 15 分钟下限')
    assert.ok(ocrTimeoutMs(444) >= 444 * 6000, '444 页应 ≥ 每页 6 秒')
    assert.ok(ocrTimeoutMs(100000) <= 60 * 60 * 1000, '预算应封顶 60 分钟')
    const windows = resolveOcrEngine({ engine: 'windows' })
    assert.ok(windows.engine === 'windows' || windows.engine === null, 'windows 引擎应可用或明确不可用')
    const bundledPython = path.join(HERE, '..', 'plugin', 'vendor', 'rapidocr', 'python', 'python.exe')
    const hasBundled = fs.existsSync(bundledPython)
    assert.equal(rapidOcrAvailable({ python: '' }), hasBundled, '随包 RapidOCR 存在时应可用（repo 可无 vendor）')
    const rapid = resolveOcrEngine({ engine: 'rapidocr' })
    if (!hasBundled && process.platform === 'win32' && windows.engine === 'windows') {
      assert.equal(rapid.fallback, true, '没有随包 RapidOCR 时应回退 Windows')
    }
    assert.equal(rapidOcrAvailable({ python: '' }), hasBundled, '未配置 python 时按随包组件判断')
    ok('OCR 预算 ≥3000ms/页、上限 60 分钟；RapidOCR 缺配置时回退')
  }

  // 5. 新建集合自动授权：只给 session + 该集合，写审计；已有 deny / 已存在集合不放行。
  {
    const dshHome = tempDir('home')
    const root = tempDir('root')
    const subject = { workspace: 'C:\\Work\\Project', session: 'session-auto-1' }
    const collection = '道路勘测设计'
    const check = canAutoGrant({ dshHome, root, subject, collection })
    assert.equal(check.ok, true, '不存在的集合应允许自动授权')
    const granted = grantNewCollection({ dshHome, root, subject, collection, tool: 'corpus_ingest' })
    assert.equal(granted.rule.session, 'session-auto-1')
    assert.deepEqual(granted.rule.paths, [collection])
    const policy = JSON.parse(fs.readFileSync(path.join(dshHome, 'corpus-access.json'), 'utf8'))
    assert.equal(policy.default, 'deny', 'default 必须保持 deny')
    assert.equal(policy.grants.length, 1)
    assert.ok(fs.existsSync(path.join(root, AUTO_GRANT_AUDIT)), '应写审计文件')
    const audit = fs.readFileSync(path.join(root, AUTO_GRANT_AUDIT), 'utf8').trim().split('\n').pop()
    assert.ok(JSON.parse(audit).collection === collection, '审计应记录目标集合')
    assert.equal(authorize(dshHome, subject, [collection]).allow(collection), true, '授权后应可写')

    fs.mkdirSync(path.join(root, collection))
    const existing = canAutoGrant({ dshHome, root, subject, collection })
    assert.equal(existing.ok, false, '集合已存在时不应自动授权')

    const dshDeny = tempDir('home-deny')
    fs.writeFileSync(path.join(dshDeny, 'corpus-access.json'), JSON.stringify({
      version: 1,
      default: 'deny',
      grants: [],
      deny: [{ workspace: '*', paths: ['禁止集合'] }],
    }))
    const denied = canAutoGrant({ dshHome: dshDeny, root: tempDir('root2'), subject, collection: '禁止集合' })
    assert.equal(denied.ok, false, '显式 deny 应阻止自动授权')
    assert.ok(String(denied.reason).includes('deny'), '拒绝原因应说明 deny')

    const dshBroken = tempDir('home-broken')
    fs.writeFileSync(path.join(dshBroken, 'corpus-access.json'), '{ not json')
    const broken = canAutoGrant({ dshHome: dshBroken, root: tempDir('root3'), subject, collection: '集合X' })
    assert.equal(broken.ok, false, '策略文件损坏时应拒绝自动授权')
    ok('自动授权：仅 session + 集合、deny/已存在/损坏不放行、可审计')
  }

  // 6. 子代理会话继承父会话的 session grant（parentSession 链）。
  {
    const dshHome = tempDir('home-chain')
    const root = tempDir('root-chain')
    const parent = 'session-parent'
    const child = 'session-child'
    const grandchild = 'session-grandchild'
    fs.writeFileSync(path.join(dshHome, 'corpus-access.json'), JSON.stringify({
      version: 1,
      default: 'deny',
      grants: [{ session: parent, paths: ['继承集合'] }],
      deny: [],
    }))
    const workspace = 'C:\\Work\\Project'
    const parentSubject = { workspace, session: parent, sessions: [parent] }
    const childSubject = { workspace, session: child, sessions: [child, parent] }
    const grandchildSubject = { workspace, session: grandchild, sessions: [grandchild, child, parent] }
    const stranger = { workspace, session: 'session-other', sessions: ['session-other'] }
    assert.equal(authorize(dshHome, parentSubject, ['继承集合']).allow('继承集合'), true, '父会话应有权限')
    assert.equal(authorize(dshHome, childSubject, ['继承集合']).allow('继承集合'), true, '子代理应继承父会话权限')
    assert.equal(authorize(dshHome, grandchildSubject, ['继承集合']).allow('继承集合'), true, '孙会话应继承整条链')
    assert.equal(authorize(dshHome, stranger, ['继承集合']).allow('继承集合'), false, '无关会话不应继承')
    const granted = grantNewCollection({ dshHome, root, subject: childSubject, collection: '子代理新建', tool: 'corpus_ingest' })
    assert.equal(granted.rule.session, parent, '子代理新建集合时授权应落在根会话')
    assert.equal(authorize(dshHome, childSubject, ['子代理新建']).allow('子代理新建'), true, '子代理可通过链使用新授权')
    ok('子代理继承父会话权限（parentSession 链；自动授权落在根会话）')
  }

  console.log('')
  console.log('v1.6 验收通过（ZIP/瘦身/公式白名单/OCR/自动授权）。')
} finally {
  for (const dir of tmpRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略清理失败 */ }
  }
}
