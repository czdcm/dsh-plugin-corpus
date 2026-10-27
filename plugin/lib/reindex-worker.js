/**
 * dsh-plugin-corpus — 重建 worker。
 *
 * 重建是同步 CPU/IO（25 MB 约 3 s，语料变大后线性增长）；放在主线程会卡住
 * 工具调用与面板请求。这里在线程里跑 engine.reindex，只把进度和结果回传。
 */
import { parentPort, workerData } from 'node:worker_threads'
import { reindex } from './engine.js'

try {
  const result = reindex(workerData.root, {
    names: Array.isArray(workerData.names) ? workerData.names : [],
    force: workerData.force === true,
    onProgress(progress) {
      try { parentPort.postMessage({ type: 'progress', progress }) } catch { /* 主线程已关闭 */ }
    },
  })
  parentPort.postMessage({ type: 'done', result })
} catch (error) {
  parentPort.postMessage({
    type: 'error',
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  })
}
