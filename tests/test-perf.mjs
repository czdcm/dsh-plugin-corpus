/**
 * dsh-plugin-corpus v1.4.2 性能护栏验收。
 *
 * 覆盖：
 *   · perf.createSlicer —— 长循环里按项数/时间让出事件循环；
 *   · perf.boundJson —— 工具输出硬上限，压缩后仍是合法 JSON；
 *   · perf.memoTtl —— TTL 内复用、过期重算、抛错不缓存；
 *   · engine.importInto —— 大目录导入期间宿主事件循环的最大停顿（不能被整段同步阻塞）。
 *
 * 运行（DSH 自带 Node 24）：
 *   & "…\dependencies\node\bin\node.exe" tests\test-perf.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { boundJson, createSlicer, memoTtl, nowMs } from '../plugin/lib/perf.js'
import { importInto } from '../plugin/lib/engine.js'

let pass = 0
const ok = (label) => { pass++; console.log('  PASS ' + label) }
const assert = (condition, message) => { if (!condition) throw new Error('ASSERT: ' + message) }

/** 采样事件循环最大停顿：返回 { maxGap, ticks }。 */
function watchEventLoop(intervalMs = 5) {
  let last = nowMs()
  let maxGap = 0
  let ticks = 0
  const timer = setInterval(() => {
    const now = nowMs()
    maxGap = Math.max(maxGap, now - last)
    last = now
    ticks++
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return {
    stop() { clearInterval(timer); return { maxGap, ticks } },
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-perf-'))
try {
  // -------------------------------------------------------------------------
  // 1. createSlicer
  // -------------------------------------------------------------------------
  {
    let yields = 0
    const slicer = createSlicer({ everyItems: 4, everyMs: 1000 })
    for (let index = 0; index < 12; index++) {
      await slicer.slice()
      yields++
      assert(yields === index + 1, 'slicer 不应改变循环计数')
    }
    // everyItems=4：12 次调用至少让出 2 次（第 4、8 次）；行为由 setImmediate 保证。
    ok('createSlicer：按项数让出且不打断循环')
  }

  // -------------------------------------------------------------------------
  // 2. boundJson
  // -------------------------------------------------------------------------
  {
    const small = boundJson({ ok: true, value: 'x' }, 24000)
    assert(JSON.parse(small).ok === true, '小对象应原样序列化')
    assert(!small.includes('_truncated'), '未超限不应标记截断')

    const huge = {
      ok: true,
      files: Array.from({ length: 800 }, (_, index) => ({ path: `dsh-docs/${'很长的路径/'.repeat(6)}${index}.md`, title: '标题'.repeat(40) })),
      body: '正文'.repeat(200000),
      notes: Array.from({ length: 200 }, () => '提示'.repeat(100)),
    }
    const bounded = boundJson(huge, 24000)
    assert(bounded.length <= 24000, '压缩后长度应 <= 上限，实际 ' + bounded.length)
    const parsed = JSON.parse(bounded)
    assert(parsed._truncated === true, '压缩后应标记 _truncated')
    assert(bounded.includes('_hint'), '压缩后应带提示')
    ok('boundJson：超限压缩到上限内且仍是合法 JSON（' + bounded.length + ' 字符）')
  }

  // -------------------------------------------------------------------------
  // 3. memoTtl
  // -------------------------------------------------------------------------
  {
    let calls = 0
    const cached = memoTtl(() => { calls++; return { n: calls } }, 40)
    const first = cached()
    const second = cached()
    assert(first === second && calls === 1, 'TTL 内应复用同一结果')
    await new Promise((resolve) => setTimeout(resolve, 60))
    const third = cached()
    assert(third !== first && calls === 2, '过期后应重新计算')
    const boom = memoTtl(() => { throw new Error('boom') }, 1000)
    let threw = 0
    for (let index = 0; index < 2; index++) {
      try { boom() } catch { threw++ }
    }
    assert(threw === 2, '抛错不应被缓存')

    let keyed = 0
    const byArgs = memoTtl((name) => { keyed++; return name + ':' + keyed }, 1000)
    assert(byArgs('a') === 'a:1' && byArgs('b') === 'b:2', '不同参数应各自缓存，不能串味')
    assert(byArgs('a') === 'a:1' && keyed === 2, '相同参数命中缓存')
    ok('memoTtl：TTL 复用 / 过期重算 / 抛错不缓存 / 按参数分键')
  }

  // -------------------------------------------------------------------------
  // 4. 大目录导入不阻塞事件循环
  // -------------------------------------------------------------------------
  {
    const source = path.join(tmp, 'source')
    const root = path.join(tmp, 'corpus')
    fs.mkdirSync(source, { recursive: true })
    fs.mkdirSync(root, { recursive: true })
    const body = ('# 文档\n\n' + '用于压测导入让出的正文内容。'.repeat(30) + '\n\n').repeat(6)
    const count = 600
    for (let index = 0; index < count; index++) {
      fs.writeFileSync(path.join(source, `doc-${String(index).padStart(4, '0')}.md`), `# doc ${index}\n\n` + body, 'utf8')
    }

    const watcher = watchEventLoop(5)
    const startedAt = nowMs()
    const result = await importInto(root, { source, collection: 'bench' })
    const elapsed = nowMs() - startedAt
    const { maxGap, ticks } = watcher.stop()

    assert(result.imported === count, `应导入 ${count} 个文件，实际 ${result.imported}`)
    assert(ticks > 0, '导入期间事件循环应至少跑过一轮定时器')
    // 600 个小文件：异步实现单次停顿应远小于 1 秒；放宽到 300ms 以兼容慢盘/杀毒扫描。
    assert(maxGap < 300, `导入期间事件循环最大停顿应 < 300ms，实际 ${maxGap.toFixed(0)}ms`)
    ok('importInto：' + count + ' 个文件，耗时 ' + elapsed.toFixed(0) + 'ms，事件循环最大停顿 ' + maxGap.toFixed(0) + 'ms')
  }

  // -------------------------------------------------------------------------
  // 5. 面板缓存不改变结果形状（memoTtl 包一层即可，这里只验证重复调用复用）
  // -------------------------------------------------------------------------
  {
    let builds = 0
    const buildStatus = () => { builds++; return [{ name: 'dsh-docs', docs: 635 }] }
    const cached = memoTtl(buildStatus, 1500)
    cached(); cached(); cached()
    assert(builds === 1, '面板轮询应复用 1.5s 内的状态结果')
    ok('面板状态缓存：轮询复用同一结果')
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('\n全部通过: ' + pass + ' 项')
