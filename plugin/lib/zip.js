/**
 * dsh-plugin-corpus — 最小 ZIP 读取器（v1.3，纯 JS，无外部依赖）。
 *
 * docx/xlsx/pptx 本质是 ZIP + XML；这里只读中央目录并对 deflate 条目调用
 * Node 内置 zlib.inflateRawSync。支持 store/deflate，忽略加密与 zip64。
 */
import zlib from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const MAX_UNCOMPRESSED = 256 * 1024 * 1024

function findEocd(buffer) {
  const start = Math.max(0, buffer.length - 65557)
  for (let index = buffer.length - 22; index >= start; index--) {
    if (buffer.readUInt32LE(index) === EOCD_SIG) return index
  }
  return -1
}

/**
 * 读取 ZIP 全部条目。
 * @returns {Map<string, Buffer>}
 */
export function readZip(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('ZIP 输入不是 Buffer')
  const eocd = findEocd(buffer)
  if (eocd < 0) throw new Error('不是有效的 ZIP（找不到 EOCD）')
  const count = buffer.readUInt16LE(eocd + 10)
  const directoryOffset = buffer.readUInt32LE(eocd + 16)
  const entries = new Map()
  let total = 0
  let cursor = directoryOffset
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > buffer.length) break
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIG) throw new Error('ZIP 中央目录损坏')
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    cursor += 46 + nameLength + extraLength + commentLength

    if (uncompressedSize > MAX_UNCOMPRESSED || total + uncompressedSize > MAX_UNCOMPRESSED) {
      throw new Error('ZIP 解压后过大，拒绝继续')
    }
    if (localOffset + 30 > buffer.length) continue
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIG) continue
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buffer.length) continue
    const raw = buffer.subarray(dataStart, dataEnd)
    let content
    if (method === 0) {
      content = Buffer.from(raw)
    } else if (method === 8) {
      try { content = zlib.inflateRawSync(raw) } catch { continue }
    } else {
      continue
    }
    total += content.length
    entries.set(name, content)
  }
  return entries
}

export function readZipFile(file) {
  // 调用方用 fs 读文件；这里只保留 Buffer 版本，避免额外依赖。
  throw new Error('readZipFile 请改用 fs.readFileSync + readZip')
}
