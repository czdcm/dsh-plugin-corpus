/**
 * dsh-plugin-corpus — 最小 ZIP 读写器（v1.6，纯 JS，无外部依赖）。
 *
 * docx/xlsx/pptx 本质是 ZIP + XML；读取用中央目录 + inflateRaw。
 * 写入/重写用于「大 Office 文件瘦身」：复制压缩后的原始条目、跳过无关媒体，
 * 不重新压缩、不修改 rels 与 [Content_Types].xml。
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

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index++) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function writeEntry(name, data, compress = true) {
  const nameBuf = Buffer.from(name, 'utf8')
  const raw = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const deflated = compress ? zlib.deflateRawSync(raw) : raw
  const body = deflated.length < raw.length ? deflated : raw
  const method = body === deflated && deflated.length < raw.length ? 8 : 0
  const crc = crc32(raw)
  return { nameBuf, body, method, crc, uncompressedSize: raw.length }
}

/**
 * 生成一个最小 ZIP（deflate/store 自动选择），用于测试与临时包。
 * @param {Record<string, Buffer|string>|Map<string, Buffer|string>} entries
 * @returns {Buffer}
 */
export function writeZip(entries) {
  const list = entries instanceof Map ? [...entries.entries()] : Object.entries(entries || {})
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, data] of list) {
    const item = writeEntry(name, data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIG, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(item.method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(item.crc, 14)
    local.writeUInt32LE(item.body.length, 18)
    local.writeUInt32LE(item.uncompressedSize, 22)
    local.writeUInt16LE(item.nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, item.nameBuf, item.body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_SIG, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(item.method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(item.crc, 16)
    central.writeUInt32LE(item.body.length, 20)
    central.writeUInt32LE(item.uncompressedSize, 24)
    central.writeUInt16LE(item.nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, item.nameBuf)
    offset += 30 + item.nameBuf.length + item.body.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(list.length, 8)
  eocd.writeUInt16LE(list.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBuf, eocd])
}

/**
 * 重写 ZIP：不解压、按条目原样复制（保留压缩数据），可跳过指定条目。
 * 用于把 300+ MB 的 PPTX 去掉内嵌视频/字体/嵌入对象后快速瘦身。
 *
 * @param {Buffer} buffer 原 ZIP。
 * @param {{skip?: (name: string) => boolean}} options
 * @returns {{buffer: Buffer, written: number, skipped: number, skippedBytes: number}}
 */
export function rewriteZip(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer)) throw new Error('ZIP 输入不是 Buffer')
  const skip = typeof options.skip === 'function' ? options.skip : () => false
  const eocd = findEocd(buffer)
  if (eocd < 0) throw new Error('不是有效的 ZIP（找不到 EOCD）')
  const count = buffer.readUInt16LE(eocd + 10)
  const directoryOffset = buffer.readUInt32LE(eocd + 16)
  if (count === 0xffff || directoryOffset === 0xffffffff) throw new Error('暂不支持 ZIP64 重写')
  const parts = []
  const centrals = []
  let cursor = directoryOffset
  let offset = 0
  let written = 0
  let skipped = 0
  let skippedBytes = 0
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > buffer.length) throw new Error('ZIP 中央目录越界')
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIG) throw new Error('ZIP 中央目录损坏')
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const crc = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const nameBuf = buffer.subarray(cursor + 46, cursor + 46 + nameLength)
    const name = nameBuf.toString('utf8')
    cursor += 46 + nameLength + extraLength + commentLength

    if (skip(name)) {
      skipped += 1
      skippedBytes += uncompressedSize
      continue
    }
    if (localOffset + 30 > buffer.length) throw new Error('ZIP 本地头越界')
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error('ZIP 本地头损坏')
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buffer.length) throw new Error('ZIP 数据越界')

    const safeFlags = flags & 0x0800
    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIG, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(safeFlags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressedSize, 18)
    local.writeUInt32LE(uncompressedSize, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    const body = buffer.subarray(dataStart, dataEnd)
    parts.push(local, nameBuf, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_SIG, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(safeFlags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressedSize, 20)
    central.writeUInt32LE(uncompressedSize, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + body.length
    written += 1
  }
  const centralBuf = Buffer.concat(centrals)
  const newEocd = Buffer.alloc(22)
  newEocd.writeUInt32LE(EOCD_SIG, 0)
  newEocd.writeUInt16LE(0, 4)
  newEocd.writeUInt16LE(0, 6)
  newEocd.writeUInt16LE(written, 8)
  newEocd.writeUInt16LE(written, 10)
  newEocd.writeUInt32LE(centralBuf.length, 12)
  newEocd.writeUInt32LE(offset, 16)
  newEocd.writeUInt16LE(0, 20)
  return { buffer: Buffer.concat([...parts, centralBuf, newEocd]), written, skipped, skippedBytes }
}
