// 性能基准（适配 1.0.0 的 root 版引擎）。
// 用法：node bench-corpus.mjs [语料根]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { collectionNames, indexPath, listDocs, readFile, reindex, search } from '../plugin/lib/engine.js'

const ROOT = process.argv[2] || path.join(os.homedir(), '.dsh', 'corpus')
const words = ['networking', 'scheduler', 'sysfs', 'DMA', '内存管理']

const built = reindex(ROOT)
let indexBytes = 0
let corpusBytes = 0
console.log(`建索引: ${built.collections.length} 个集合 / ${built.ms} ms`)
for (const item of built.collections) {
  const file = indexPath(ROOT, item.collection)
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0
  indexBytes += size
  for (const doc of listDocs(ROOT, { collections: [item.collection], limit: 1000 }).collections[0]?.files || []) corpusBytes += doc.bytes
  console.log(`  ${item.collection.padEnd(18)} ${String(item.docs).padStart(3)} 篇 / ${String(item.chunks).padStart(6)} 块 / ${(size / 1024 / 1024).toFixed(1)} MB / ${item.backend}`)
}
console.log(`原文 ${(corpusBytes / 1024 / 1024).toFixed(1)} MB；索引 ${(indexBytes / 1024 / 1024).toFixed(1)} MB（约 ${(indexBytes / Math.max(1, corpusBytes)).toFixed(2)}×）`)

const noop = reindex(ROOT)
console.log(`增量重扫（无变化）: ${noop.ms} ms`)

const names = collectionNames(ROOT)
for (const word of words) {
  for (let i = 0; i < 2; i++) search(ROOT, { collections: names, query: word, limit: 8 })
  const started = performance.now()
  let hits = 0
  for (let i = 0; i < 5; i++) hits = search(ROOT, { collections: names, query: word, limit: 8 }).hits.length
  console.log(`  检索 "${word}": ${((performance.now() - started) / 5).toFixed(1)} ms（${hits} 条）`)
}

const first = listDocs(ROOT, { collections: names, limit: 1 }).collections[0]
if (first && first.files.length > 0) {
  const started = performance.now()
  const read = readFile(ROOT, first.files[0].path, { from: 1, lines: 120 })
  console.log(`  读取 ${first.files[0].path}: ${(performance.now() - started).toFixed(1)} ms（共 ${read.totalLines} 行）`)
}
