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

function streamChunks(latin1) {
  const chunks = []
  const marker = /(?:^|[\r\n])stream\r?\n/g
  let match
  while ((match = marker.exec(latin1)) !== null) {
    const dataStart = match.index + match[0].length
    const end = latin1.indexOf('endstream', dataStart)
    if (end < 0) continue
    const dictionary = latin1.slice(Math.max(0, match.index - 800), match.index)
    const raw = latin1.slice(dataStart, end)
    let buffer = Buffer.from(raw, 'latin1')
    if (/\/FlateDecode/.test(dictionary)) {
      try { buffer = zlib.inflateSync(buffer) } catch { /* 不是有效 deflate，跳过 */ }
    }
    const text = buffer.toString('latin1')
    if (/\bTj\b|\bTJ\b/.test(text)) chunks.push(text)
  }
  return chunks
}

export function extractPdfText(buffer) {
  const latin1 = buffer.toString('latin1')
  const chunks = streamChunks(latin1)
  if (chunks.length === 0) return ''
  const text = chunks.map(textFromContent).join('\n')
  return text
    .replace(/[^\x09\x0a\x0d\x20-\x7e\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
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
export function runWindowsOcr(file, mode = 'image', timeoutMs = 300000) {
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
    execFile(powershell, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', script,
      '-Path', file,
      '-Mode', mode,
    ], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`内置 OCR 失败：${String(stderr || error.message).trim()}`))
        return
      }
      resolve(String(stdout || '').trim())
    })
  })
}
