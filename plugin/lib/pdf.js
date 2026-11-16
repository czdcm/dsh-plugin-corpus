/**
 * dsh-plugin-corpus — PDF 文本提取 + 内置 OCR 兜底（v1.4.3）。
 *
 * 发布版一律随包携带 pdftotext（vendor/pdftotext），因此不再保留纯 JS 的
 * PDF 文字层解析兜底：
 *   · 文字版 PDF：用随包 pdftotext 抽文字（异步子进程，不占主线程）；
 *   · 扫描版/无文字层：调用插件内置 ocr_windows.ps1
 *     （Windows.Data.Pdf 渲染 + Windows.Media.Ocr），同样是子进程。
 *
 * 为什么移除纯 JS 解析：它会把扫描件里的 DCT/JPX 图片流也当文本解码，
 * 24 MB 的扫描书实测占满宿主主线程十几分钟（CHANGELOG 1.4.3 有完整记录）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * 判断 PDF 文字层是否像可读正文。
 * pdftotext 在扫描件上会输出空文本/换页符；坏 PDF 可能输出压缩流乱码。
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

/** 按 pdftotext 的分页符（\f）拆页。pdftotext 每页末尾都会输出 \f，所以只去掉末尾那一个空段，
 *  末尾真正的空白页（扫描页）会以空段的形式保留下来，交给逐页 OCR 补齐。 */
export function splitPdfPages(text) {
  const raw = String(text || '')
  if (raw.trim() === '') return []
  const parts = raw.split('\f')
  if (parts.length > 0 && parts[parts.length - 1].trim() === '') parts.pop()
  return parts
}

/** 把 1-based 页码数组压成 "1-3,5,9-10" 形式，供 OCR 脚本只渲染缺文字的页。 */
export function compressPageRanges(pages) {
  const sorted = [...new Set((Array.isArray(pages) ? pages : []).filter((n) => Number.isInteger(n) && n >= 1))].sort((a, b) => a - b)
  const parts = []
  let start = null
  let prev = null
  for (const page of sorted) {
    if (start === null) { start = page; prev = page; continue }
    if (page === prev + 1) { prev = page; continue }
    parts.push(start === prev ? String(start) : `${start}-${prev}`)
    start = page
    prev = page
  }
  if (start !== null) parts.push(start === prev ? String(start) : `${start}-${prev}`)
  return parts.join(',')
}

/** 判断某一页是否需要 OCR：没有文字层，或文字层明显是乱码；太短但干净的页（封面/扉页）保留文字层。 */
export function needsOcrPage(pageText) {
  const value = String(pageText || '').trim()
  if (value === '') return true
  const quality = pdfTextQuality(value)
  if (quality.ok) return false
  return quality.reason !== 'too-short'
}

/**
 * 合并文字层分页与 OCR 分页：每页优先用可读的文字层，缺文字/乱码的页用 OCR。
 * @param {string[]} textPages pdftotext 分页文本（可能为空数组）。
 * @param {Map<number,string>} ocrPages OCR 结果（1-based 页码 → 文本）。
 * @param {number} pageCount 总页数。
 * @returns {{pages: string[], textPages: number, ocrPages: number, weakPages: number, emptyPages: number}}
 */
export function mergePdfPageTexts(textPages, ocrPages, pageCount) {
  const total = Math.max(0, Number(pageCount) || 0)
  const textList = Array.isArray(textPages) ? textPages : []
  const ocrMap = ocrPages instanceof Map ? ocrPages : new Map()
  const pages = []
  let usedText = 0
  let usedOcr = 0
  let weak = 0
  let empty = 0
  for (let page = 1; page <= total; page++) {
    const fromText = String(textList[page - 1] || '').trim()
    if (!needsOcrPage(fromText)) {
      pages.push(fromText)
      usedText++
      continue
    }
    const fromOcr = String(ocrMap.get(page) || '').trim()
    if (fromOcr !== '') {
      pages.push(fromOcr)
      usedOcr++
      continue
    }
    if (fromText !== '') { weak++ } else { empty++ }
    pages.push(fromText)
  }
  return { pages, textPages: usedText, ocrPages: usedOcr, weakPages: weak, emptyPages: empty }
}

/**
 * 解析 ocr_windows.ps1 的分页输出（`--- Page N ---` / `--- Page N (OCR failed: …) ---`）。
 * @returns {{pages: Map<number,string>, failures: Map<number,string>}}
 */
export function parseOcrPages(stdout) {
  const text = String(stdout || '')
  const pages = new Map()
  const failures = new Map()
  const marker = /--- Page (\d+)(?: \(OCR failed: ([\s\S]*?)\))? ---/g
  const marks = []
  let match
  while ((match = marker.exec(text)) !== null) {
    marks.push({ start: match.index, end: match.index + match[0].length, page: Number(match[1]), failed: match[2] !== undefined, message: match[2] || '' })
  }
  for (let index = 0; index < marks.length; index++) {
    const mark = marks[index]
    const bodyStart = mark.end
    const bodyEnd = index + 1 < marks.length ? marks[index + 1].start : text.length
    const body = text.slice(bodyStart, bodyEnd).trim()
    if (mark.failed) failures.set(mark.page, body === '' ? mark.message : body)
    else pages.set(mark.page, body)
  }
  return { pages, failures }
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
      reject(new Error('插件内没有随包 pdftotext（官方完整包应包含）'))
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
  const bundled = bundledPdftotext() !== null
  return {
    text: bundled,
    bundled,
    ocr: ocrAvailable(),
  }
}

/**
 * 调用插件内置的 Windows OCR 脚本；返回原始分页文本（由 parseOcrPages 解析）。
 * @param {string} file 图片或 PDF 路径。
 * @param {'image'|'pdf'} mode
 * @param {number} timeoutMs 子进程超时（默认 15 分钟）。
 * @param {{pages?: string}} [options] pages：PDF 页码范围（如 "1-3,7"），只裁剪这些页；image 模式忽略。
 */
export function runWindowsOcr(file, mode = 'image', timeoutMs = 900000, options = {}) {
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
    const args = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', script,
      '-Path', nativeFile,
      '-Mode', mode,
    ]
    const pages = typeof options.pages === 'string' ? options.pages.trim() : ''
    if (pages !== '') args.push('-Pages', pages)
    const renderHeight = Number(options.renderHeight) || 0
    if (renderHeight > 0) args.push('-RenderHeight', String(Math.round(renderHeight)))
    execFile(powershell, args, {
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

/* ------------------------------------------------------------------
 * OCR 引擎选择（v1.6）：Windows OCR 兜底 + 可选 RapidOCR（PP-OCRv4，中文表格更准）。
 * RapidOCR 通过外部 Python 虚拟环境调用（插件不打包 onnxruntime）；未配置时自动跳过。
 * ------------------------------------------------------------------ */

export function rapidOcrScriptPath() {
  return path.join(HERE, 'rapidocr_ocr.py')
}

/** 随包 RapidOCR 的 Python 解释器（vendor/rapidocr/python/python.exe）。 */
export function bundledRapidOcrPython() {
  const candidate = path.join(HERE, '..', 'vendor', 'rapidocr', 'python', 'python.exe')
  try { return fs.statSync(candidate).isFile() ? candidate : null } catch { return null }
}

/** 随包 RapidOCR 的依赖目录（vendor/rapidocr/site-packages）。 */
export function bundledRapidOcrSitePackages() {
  const candidate = path.join(HERE, '..', 'vendor', 'rapidocr', 'site-packages')
  try { return fs.statSync(candidate).isDirectory() ? candidate : null } catch { return null }
}

/** 是否可用 RapidOCR：随包 Python 或外部配置的 python + 识别脚本。 */
export function rapidOcrAvailable(options = {}) {
  const configured = String(options.python || '').trim()
  if (configured !== '') {
    try {
      if (!fs.statSync(configured).isFile()) return false
    } catch {
      return false
    }
  } else if (bundledRapidOcrPython() === null) {
    return false
  }
  return fs.existsSync(rapidOcrScriptPath())
}

/**
 * 选择 OCR 引擎。
 * @param {{engine?: 'auto'|'windows'|'rapidocr', python?: string}} options
 * @returns {{engine: 'windows'|'rapidocr'|null, fallback: boolean, reason: string}}
 */
export function resolveOcrEngine(options = {}) {
  const want = String(options.engine || 'auto').trim().toLowerCase()
  const rapid = rapidOcrAvailable(options)
  const windows = ocrAvailable()
  if (want === 'windows') {
    return windows
      ? { engine: 'windows', fallback: false, reason: '' }
      : { engine: null, fallback: false, reason: '当前系统没有可用的 Windows OCR' }
  }
  if (want === 'rapidocr') {
    if (rapid) return { engine: 'rapidocr', fallback: false, reason: '' }
    return windows
      ? { engine: 'windows', fallback: true, reason: 'RapidOCR 不可用（随包组件缺失且未配置 ocrPython），已回退 Windows OCR' }
      : { engine: null, fallback: false, reason: 'RapidOCR 与 Windows OCR 都不可用' }
  }
  if (rapid) return { engine: 'rapidocr', fallback: false, reason: '' }
  if (windows) return { engine: 'windows', fallback: false, reason: '' }
  return { engine: null, fallback: false, reason: '本机没有可用的 OCR 引擎' }
}

/** 逐页 OCR 的时间预算：每页默认 6 s，下限 15 分钟、上限 60 分钟。 */
export function ocrTimeoutMs(pageCount, options = {}) {
  const pages = Math.max(1, Number(pageCount) || 1)
  const perPage = Math.max(1000, Math.min(120000, Number(options.pageTimeoutMs) || 6000))
  return Math.min(60 * 60 * 1000, Math.max(15 * 60 * 1000, pages * perPage))
}

function execFileAsync(executable, args, options) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message).trim()))
        return
      }
      resolve(String(stdout || ''))
    })
  })
}

/** 用 Windows.Data.Pdf 把指定页渲染成 PNG（供 RapidOCR 识别），返回 [{page, path}]。 */
async function renderPdfPages(file, pages, renderHeight, outDir, timeoutMs) {
  const powershell = findPowerShell()
  if (powershell === null) throw new Error('找不到 Windows PowerShell，无法渲染 PDF 页面')
  const script = ocrScriptPath()
  if (!fs.existsSync(script)) throw new Error('缺少内置 ocr_windows.ps1')
  const nativeFile = String(file).split('/').join('\\')
  const args = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-Path', nativeFile,
    '-Mode', 'pdf',
    '-RenderOnly',
    '-OutDir', outDir,
    '-RenderHeight', String(Math.round(Number(renderHeight) || 3000)),
  ]
  if (typeof pages === 'string' && pages.trim() !== '') args.push('-Pages', pages.trim())
  const stdout = await execFileAsync(powershell, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
  })
  const entries = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^--- Page (\d+) (.+) ---$/)
    if (match) entries.push({ page: Number(match[1]), path: match[2].trim() })
  }
  if (entries.length === 0) throw new Error('PDF 页面渲染没有产出（检查 PowerShell 输出）')
  return entries
}

/**
 * 调 RapidOCR（外部 Python 脚本：PP-OCRv4 识别）。
 * Windows 上先用 Windows.Data.Pdf 渲染成 3000px PNG，再交给 Python 识别（不依赖 PyMuPDF）；
 * 其它平台退化为传 PDF 路径（需要 pymupdf）。
 *
 * @param {string} file PDF 路径。
 * @param {number} timeoutMs 子进程超时。
 * @param {{python?: string, pages?: string, renderHeight?: number}} options
 */
export async function runRapidOcr(file, timeoutMs, options = {}) {
  const configured = String(options.python || '').trim()
  const python = configured !== '' ? configured : bundledRapidOcrPython()
  if (python === null || python === '') {
    throw new Error('没有可用的 RapidOCR Python（随包 vendor/rapidocr 缺失，且未配置 ocrPython）')
  }
  const script = rapidOcrScriptPath()
  if (!fs.existsSync(script)) throw new Error('缺少内置 rapidocr_ocr.py')
  const env = { ...process.env }
  if (configured === '') {
    // 随包解释器不会自动找 vendor/site-packages；用 PYTHONPATH 指过去。
    const sitePackages = bundledRapidOcrSitePackages()
    if (sitePackages !== null) {
      env.PYTHONPATH = env.PYTHONPATH ? `${sitePackages};${env.PYTHONPATH}` : sitePackages
    }
  }
  let renderDir = null
  try {
    const args = [script]
    const useWindowsRender = process.platform === 'win32' && findPowerShell() !== null
    if (useWindowsRender) {
      renderDir = fs.mkdtempSync(path.join(path.dirname(HERE), 'rapidocr-tmp-'))
      const entries = await renderPdfPages(
        file,
        typeof options.pages === 'string' ? options.pages : '',
        options.renderHeight || 3000,
        renderDir,
        timeoutMs,
      )
      const manifest = path.join(renderDir, 'manifest.json')
      fs.writeFileSync(manifest, JSON.stringify(entries), 'utf8')
      args.push('--manifest', manifest)
    } else {
      args.push('--path', file)
      if (typeof options.pages === 'string' && options.pages.trim() !== '') args.push('--pages', options.pages.trim())
      args.push('--render-height', String(Math.round(Number(options.renderHeight) || 3000)))
    }
    const stdout = await execFileAsync(python, args, {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
      env,
    })
    return normalizeOcrText(stdout)
  } catch (error) {
    throw new Error(`RapidOCR 失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (renderDir !== null) {
      try { fs.rmSync(renderDir, { recursive: true, force: true }) } catch { /* 清理失败不影响结果 */ }
    }
  }
}

/** 按引擎名调用对应 OCR。 */
export function runOcr(engine, file, mode, timeoutMs, options = {}) {
  if (engine === 'rapidocr') return runRapidOcr(file, timeoutMs, options)
  return runWindowsOcr(file, mode, timeoutMs, options)
}
