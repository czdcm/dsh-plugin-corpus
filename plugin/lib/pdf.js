/**
 * dsh-plugin-corpus — PDF 文本提取 + 内置 OCR 兜底（v1.3）。
 *
 * 1) 先用纯 JS 从 PDF 内容流里直接抽文字（快、对文字版 PDF 足够）；
 * 2) 抽不出/太少时，调用**插件内自带**的 ocr_windows.ps1：
 *    用 Windows 自带的 PDF 渲染 + OCR 引擎（Windows.Data.Pdf / Windows.Media.Ocr），
 *    不依赖 pdftoppm/tesseract 等外部安装。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function decodePdfString(raw) {
  let value = ''
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]
    if (char !== '\\') { value += char; continue }
    const next = raw[index + 1]
    if (next === undefined) break
    index += 1
    if (next === 'n') value += '\n'
    else if (next === 'r') value += '\r'
    else if (next === 't') value += '\t'
    else if (next === 'b') value += '\b'
    else if (next === 'f') value += '\f'
    else if (next === '(' || next === ')' || next === '\\') value += next
    else if (/[0-7]/.test(next)) {
      let octal = next
      for (let count = 0; count < 2 && /[0-7]/.test(raw[index + 1]); count++) {
        octal += raw[index + 1]
        index += 1
      }
      value += String.fromCharCode(parseInt(octal, 8))
    } else if (next === '\n') { /* 续行 */ }
    else value += next
  }
  return value
}

function textFromContent(content) {
  const parts = []
  // Tj / ' / " 的字符串
  const simple = /\((?:\\[\s\S]|[^\\()])*\)\s*(?:Tj|'|")/g
  // TJ 数组
  const array = /\[((?:[^\[\]]|\((?:\\[\s\S]|[^\\()])*\))*)\]\s*TJ/g
  // 换行/定位粗略处理
  const position = /\b(?:T\*|TD|Td|Tm)\b/g
  const combined = new RegExp(`${simple.source}|${array.source}|${position.source}`, 'g')
  let match
  while ((match = combined.exec(content)) !== null) {
    const token = match[0]
    if (/^\(/.test(token)) {
      const end = token.lastIndexOf(')')
      parts.push(decodePdfString(token.slice(1, end)))
      continue
    }
    if (token.startsWith('[')) {
      const body = token.slice(1, token.lastIndexOf(']'))
      const itemRegexp = /\((?:\\[\s\S]|[^\\()])*\)|-?\d+(?:\.\d+)?/g
      let item
      while ((item = itemRegexp.exec(body)) !== null) {
        if (item[0].startsWith('(')) {
          parts.push(decodePdfString(item[0].slice(1, -1)))
        } else if (Number(item[0]) < -100) {
          parts.push(' ')
        }
      }
      continue
    }
    parts.push('\n')
  }
  return parts.join('')
}

function streamChunks(latin1, options = {}) {
  const deadline = Math.max(0, Number(options.deadline) || 0)
  const chunks = []
  const marker = /(?:^|[\r\n])stream\r?\n/g
  let match
  while ((match = marker.exec(latin1)) !== null) {
    // 扫描版 PDF 里绝大多数体积是图片流；纯 JS 解析对它们没有意义，
    // 还会把 24 MB 的 JPEG 当成文本解码（实测可卡死主线程十几分钟）。
    if (deadline > 0 && Date.now() > deadline) break
    const dataStart = match.index + match[0].length
    const end = latin1.indexOf('endstream', dataStart)
    if (end < 0) continue
    const dictionary = latin1.slice(Math.max(0, match.index - 800), match.index)
    if (/\/DCTDecode|\/JPXDecode|\/CCITTFaxDecode|\/JBIG2Decode/.test(dictionary)) continue
    const raw = latin1.slice(dataStart, end)
    if (raw.length > 16 * 1024 * 1024) continue
    let buffer = Buffer.from(raw, 'latin1')
    if (/\/FlateDecode/.test(dictionary)) {
      try { buffer = zlib.inflateSync(buffer) } catch { /* 不是有效 deflate，跳过 */ }
    }
    const text = buffer.toString('latin1')
    if (text.length > 8 * 1024 * 1024) continue
    if (/\bTj\b|\bTJ\b/.test(text)) chunks.push(text)
  }
  return chunks
}

/**
 * 从 PDF 内容流里直接抽文字（纯 JS 兜底，不依赖外部程序）。
 *
 * v1.4.3：加时间预算并跳过图片流。扫描件/大 PDF 上旧实现会同步解码所有流，
 * 实测 24 MB 扫描书可占满主线程十几分钟；现在最多跑 maxMs，超时返回已抽到的部分。
 *
 * @param {Buffer} buffer PDF 文件内容。
 * @param {{maxMs?: number}} [options] 时间预算，默认 3000ms。
 * @returns {string} 抽到的文本（可能为空）。
 */
export function extractPdfText(buffer, options = {}) {
  const maxMs = Math.max(50, Number(options.maxMs) || 3000)
  const latin1 = buffer.toString('latin1')
  const chunks = streamChunks(latin1, { deadline: Date.now() + maxMs })
  if (chunks.length === 0) return ''
  const text = chunks.map(textFromContent).join('\n')
  return text
    .replace(/[^\x09\x0a\x0d\x20-\x7e\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 判断 PDF 文字层是否像可读正文。
 * 压缩流/对象流被误当文本时会出现大量符号、缺少空格，并夹带 PDF/JPEG 标记；
 * 这类结果必须在 OCR 兜底前丢弃，不能写进 processed。
 */
export function pdfTextQuality(value) {
  const raw = String(value || '')
  const text = raw.trim()
  if (text.length < 40) {
    return { ok: false, reason: 'too-short', length: text.length, spaceRatio: 0, symbolRatio: 0, binaryHits: 0 }
  }
  const sample = text.slice(0, 200000)
  const chars = Array.from(sample)
  let letters = 0
  let digits = 0
  let spaces = 0
  let symbols = 0
  let controls = 0
  let longestRun = 0
  let run = 0
  for (const char of chars) {
    const code = char.codePointAt(0)
    if (/\s/.test(char)) {
      spaces += 1
      run = 0
    } else {
      if (code < 32) controls += 1
      if (/[A-Za-z\u4e00-\u9fff]/u.test(char)) letters += 1
      else if (/[0-9]/.test(char)) digits += 1
      else symbols += 1
      run += 1
      if (run > longestRun) longestRun = run
    }
  }
  const total = chars.length || 1
  const spaceRatio = spaces / total
  const symbolRatio = symbols / total
  const controlRatio = controls / total
  const binaryHits = (sample.match(/Adobe_CM|JFIF|endstream|FlateDecode|beginbfchar|endbfchar|%PDF-|obj\s*<<|xref/gi) || []).length
  let reason = null
  if (binaryHits >= 2) reason = 'pdf-binary-markers'
  else if (controlRatio > 0.01) reason = 'control-characters'
  else if (spaceRatio < 0.04 && symbolRatio > 0.22) reason = 'low-space-high-symbols'
  else if (symbolRatio > 0.38) reason = 'high-symbols'
  else if ((letters + digits) / total < 0.25) reason = 'low-letters'
  else if (longestRun > 400 && spaceRatio < 0.08) reason = 'long-unbroken-runs'
  return {
    ok: reason === null,
    reason,
    length: text.length,
    spaceRatio: Number(spaceRatio.toFixed(4)),
    symbolRatio: Number(symbolRatio.toFixed(4)),
    controlRatio: Number(controlRatio.toFixed(4)),
    binaryHits,
    longestRun,
  }
}

export function isUsablePdfText(value) {
  return pdfTextQuality(value).ok
}

/** Windows OCR 常把中文逐字用空格隔开；合并 CJK 之间的空格，保留英文词间距与换行。 */
export function normalizeOcrText(value) {
  return String(value || '')
    .replace(/(?<=[\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/gu, '')
    .replace(/(?<=[\u4e00-\u9fff])[ \t]+(?=[，。；：、！？（）《》【】])/gu, '')
    .replace(/(?<=[，。；：、！？（）《》【】])[ \t]+(?=[\u4e00-\u9fff])/gu, '')
}

export function findPowerShell() {
  const candidates = [
    process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '',
    'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    try { if (fs.statSync(candidate).isFile()) return candidate } catch { /* 继续 */ }
  }
  return null
}

export function ocrScriptPath() {
  return path.join(HERE, 'ocr_windows.ps1')
}

export function ocrAvailable() {
  return process.platform === 'win32' && findPowerShell() !== null && fs.existsSync(ocrScriptPath())
}

/** 插件随包携带的 pdftotext（Windows x64）。搬走插件后仍可用。 */
export function bundledPdftotext() {
  if (process.platform !== 'win32') return null
  const candidate = path.join(HERE, '..', 'vendor', 'pdftotext', 'pdftotext.exe')
  try { return fs.statSync(candidate).isFile() ? candidate : null } catch { return null }
}

/** 用随包 pdftotext 提取文字（异步，不阻塞事件循环）。 */
export function runBundledPdftotext(file, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const executable = bundledPdftotext()
    if (executable === null) {
      reject(new Error('插件内没有 pdftotext（非 Windows x64 部署）'))
      return
    }
    execFile(executable, ['-layout', '-enc', 'UTF-8', file, '-'], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`pdftotext 失败：${String(stderr || error.message).trim()}`))
        return
      }
      resolve(String(stdout || ''))
    })
  })
}

export function pdfExtractorAvailability() {
  return {
    text: true,
    bundled: bundledPdftotext() !== null,
    ocr: ocrAvailable(),
  }
}

/** 调用插件内置的 Windows OCR 脚本；返回纯文本。 */
export function runWindowsOcr(file, mode = 'image', timeoutMs = 900000) {
  return new Promise((resolve, reject) => {
    const powershell = findPowerShell()
    if (powershell === null) {
      reject(new Error('找不到 Windows PowerShell，无法使用内置 OCR'))
      return
    }
    const script = ocrScriptPath()
    if (!fs.existsSync(script)) {
      reject(new Error('缺少内置 ocr_windows.ps1'))
      return
    }
    // Windows.Data.Pdf 的 GetFileFromPathAsync 不接受正斜杠路径；统一成原生反斜杠。
    const nativeFile = String(file).split('/').join('\\')
    execFile(powershell, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', script,
      '-Path', nativeFile,
      '-Mode', mode,
    ], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`内置 OCR 失败：${String(stderr || error.message).trim()}`))
        return
      }
      resolve(normalizeOcrText(String(stdout || '').trim()))
    })
  })
}
