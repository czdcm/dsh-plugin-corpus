/**
 * dsh-plugin-corpus v1.7 — 删除语料（软删除到 .corpus/trash，可人工恢复）。
 *
 * 删除单篇：如果 processed 文件属于 v1.3 的每导入一文件夹布局，连整个导入文件夹
 * （processed/.meta.json）一起移到 trash；旧版平铺文本只移该文件。
 * 删除集合：整个集合目录移到 trash/collections/ 下，并清掉该集合的索引文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { collectionNameError, isValidCollectionName } from './collection-name.js'

function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function uniqueTrashDir(root) {
  const base = path.join(root, '.corpus', 'trash')
  let name = stamp()
  let counter = 2
  while (fs.existsSync(path.join(base, name))) {
    name = `${stamp()}-${counter}`
    counter += 1
  }
  return path.join(base, name)
}

function moveToTrash(root, relTarget, label) {
  const source = path.resolve(root, ...relTarget.split('/'))
  const rootAbs = path.resolve(root)
  if (!source.startsWith(rootAbs + path.sep)) throw new Error('目标不在语料根内')
  let stat
  try { stat = fs.lstatSync(source) } catch { throw new Error('目标不存在或已被删除') }
  if (stat.isSymbolicLink()) throw new Error('拒绝删除符号链接')
  if (!stat.isDirectory() && !stat.isFile()) throw new Error('不是普通文件/目录')
  const trashRoot = uniqueTrashDir(root)
  const destination = path.join(trashRoot, label ? label : '', ...relTarget.split('/'))
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  try {
    fs.renameSync(source, destination)
  } catch {
    fs.cpSync(source, destination, { recursive: true, force: false, errorOnExist: false })
    fs.rmSync(source, { recursive: true, force: true })
  }
  return path.relative(root, destination).replace(/\\/g, '/')
}

/** 删除一篇 processed 语料（导入文件夹布局时连遗留原件一起）。 */
export function deleteDocument(root, relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/')
  const parts = rel.split('/')
  if (rel === '' || parts.some((part) => part === '' || part === '..' || part === '.')) throw new Error('非法语料路径')
  if (parts.includes('.corpus') || parts.includes('originals')) throw new Error('不能删除元数据或原件目录')
  const collection = parts[0]
  if (!isValidCollectionName(collection)) throw new Error(collectionNameError(collection))
  const processedIndex = parts.indexOf('processed')
  const targetRel = processedIndex > 1 ? parts.slice(0, processedIndex).join('/') : rel
  if (!targetRel.startsWith(collection + '/') && targetRel !== collection) throw new Error('目标越界')
  const trashed = moveToTrash(root, targetRel, '')
  return { kind: processedIndex > 1 ? 'import-folder' : 'file', collection, target: targetRel, trashed }
}

function removeCollectionIndex(root, collection) {
  const indexDir = path.join(root, '.corpus', 'index')
  let entries = []
  try { entries = fs.readdirSync(indexDir) } catch { return }
  for (const entry of entries) {
    const indexPrefix = collection + '.sqlite'
    if (entry === indexPrefix || entry.startsWith(indexPrefix + '-')) {
      try { fs.rmSync(path.join(indexDir, entry), { force: true }) } catch { /* 索引可能正被占用 */ }
    }
  }
}

/** 删除整个集合（移到 trash/collections/，并清理索引文件）。 */
export function deleteCollection(root, name) {
  const collection = String(name || '').trim()
  if (!isValidCollectionName(collection)) throw new Error(collectionNameError(collection))
  const source = path.join(root, collection)
  let stat
  try { stat = fs.lstatSync(source) } catch { throw new Error(`集合不存在：${collection}`) }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('集合不是普通目录')
  const trashed = moveToTrash(root, collection, 'collections')
  removeCollectionIndex(root, collection)
  return { kind: 'collection', collection, trashed }
}
