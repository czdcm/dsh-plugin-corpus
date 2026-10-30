/**
 * dsh-plugin-corpus — 后台重建任务管理器。
 *
 * 同一进程同一时刻只跑一个重建任务；跨进程用 lock.js 的锁文件仲裁。
 * 工具与面板都通过这里启动/查询任务，重建本身跑在 worker 里，不阻塞主线程。
 */
import { Worker } from 'node:worker_threads'
import { acquireLock } from './lock.js'

const WORKER_URL = new URL('./reindex-worker.js', import.meta.url)
const HISTORY_LIMIT = 10

function jobId() {
  return `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** 对外暴露的任务快照：去掉下划线开头的内部字段，并复制 progress。 */
function publicJob(job) {
  if (!job) return null
  const snapshot = {}
  for (const [key, value] of Object.entries(job)) {
    if (key.startsWith('_')) continue
    snapshot[key] = key === 'progress' && value ? { ...value } : value
  }
  return snapshot
}

/**
 * @param root - 语料根目录。
 * @param log - 可选日志函数 (level, message)。
 * @returns 管理器：start / status / wait / dispose。
 */
export function createJobRunner({ root, log }) {
  const recent = []
  const waiters = new Map()
  let active = null
  let disposed = false

  const finish = (job, state, extra) => {
    if (job.state !== 'running') return
    job.state = state
    job.finishedAt = Date.now()
    job.ms = job.finishedAt - job.startedAt
    if (extra && typeof extra === 'object') Object.assign(job, extra)
    try { job._lock.release() } catch { /* 释放失败不改变任务结果 */ }
    if (active === job) active = null
    recent.unshift(publicJob(job))
    if (recent.length > HISTORY_LIMIT) recent.length = HISTORY_LIMIT
    const waiter = waiters.get(job.id)
    if (waiter) {
      waiters.delete(job.id)
      waiter.resolve(publicJob(job))
    }
  }

  const start = ({ names = [], force = false } = {}) => {
    if (disposed) throw new Error('重建任务管理器已关闭')
    if (active) return { started: false, job: publicJob(active) }

    const wanted = Array.isArray(names) ? names.filter((name) => typeof name === 'string' && name !== '') : []
    const lock = acquireLock(root, wanted)
    if (!lock.ok) return { started: false, locked: lock.locked }

    const job = {
      id: jobId(),
      state: 'running',
      names: wanted,
      force: force === true,
      startedAt: Date.now(),
      finishedAt: null,
      ms: null,
      progress: null,
      result: null,
      error: null,
      _lock: lock,
      _worker: null,
    }

    let worker
    try {
      worker = new Worker(WORKER_URL, {
        workerData: { root, names: job.names, force: job.force },
      })
    } catch (error) {
      // 某些运行时不允许 worker_threads：退回主线程重建（会阻塞，但功能不丢）。
      // v1.4.2：按集合分片并让出事件循环，避免一次全量重建把宿主卡死；同时打日志方便排查。
      if (typeof log === 'function') {
        log('warn', `索引重建 worker 不可用，退回主线程分片重建：${error instanceof Error ? error.message : String(error)}`)
      }
      active = job
      setImmediate(async () => {
        try {
          const { reindex, collectionNames } = await import('./engine.js')
          const names = job.names.length > 0 ? job.names : collectionNames(root)
          const merged = { ok: true, root, ms: 0, collections: [] }
          for (const name of names) {
            const one = reindex(root, {
              names: [name],
              force: job.force,
              onProgress(progress) { job.progress = progress },
            })
            if (Array.isArray(one.collections)) merged.collections.push(...one.collections)
            merged.ms += Number(one.ms) || 0
            await new Promise((resolve) => setImmediate(resolve))
          }
          finish(job, 'done', { result: merged })
        } catch (fallbackError) {
          finish(job, 'error', { error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError) })
        }
      })
      return { started: true, job: publicJob(job) }
    }

    job._worker = worker
    active = job

    worker.on('message', (message) => {
      if (!message || typeof message !== 'object') return
      if (message.type === 'progress') {
        job.progress = message.progress && typeof message.progress === 'object' ? message.progress : null
        return
      }
      if (message.type === 'done') {
        finish(job, 'done', { result: message.result })
        return
      }
      if (message.type === 'error') {
        finish(job, 'error', { error: String(message.error || '重建失败') })
      }
    })

    worker.on('error', (error) => {
      finish(job, 'error', { error: error instanceof Error ? error.message : String(error) })
    })

    worker.on('exit', (code) => {
      if (job.state !== 'running') return
      finish(job, 'error', {
        error: code === 0
          ? 'worker 已退出但没有返回重建结果'
          : `重建 worker 退出码 ${code}`,
      })
    })

    return { started: true, job: publicJob(job) }
  }

  const status = () => ({
    active: publicJob(active),
    recent: recent.map((job) => ({ ...job })),
  })

  /** 等任务结束；给测试与需要同步结果的调用方用。 */
  const wait = (id, timeoutMs = 60000) => {
    const found = (active && active.id === id ? active : null) || recent.find((job) => job.id === id)
    if (!found) return Promise.reject(new Error(`找不到任务 ${id}`))
    if (found.state !== 'running') return Promise.resolve(publicJob(found))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id)
        reject(new Error(`等待任务 ${id} 超时（${timeoutMs}ms）`))
      }, Math.max(1, Number(timeoutMs) || 60000))
      if (typeof timer.unref === 'function') timer.unref()
      waiters.set(id, {
        resolve(value) { clearTimeout(timer); resolve(value) },
        reject(error) { clearTimeout(timer); reject(error) },
      })
    })
  }

  const dispose = () => {
    disposed = true
    if (active) {
      const job = active
      try { job._worker.terminate() } catch { /* 已退出 */ }
      try { job._lock.release() } catch { /* 已释放 */ }
      job.state = 'error'
      job.error = '任务随插件关闭被终止'
      job.finishedAt = Date.now()
      active = null
    }
    for (const waiter of waiters.values()) waiter.reject(new Error('重建任务管理器已关闭'))
    waiters.clear()
  }

  return { start, status, wait, dispose }
}
