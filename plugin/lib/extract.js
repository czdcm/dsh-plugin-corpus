/**
 * dsh-plugin-corpus — 文档提取（v1.3，可随插件整体搬走）。
 *
 * 不依赖本机安装的 pdftotext / officecli / Python：
 *   · .md/.txt/.csv/.html  纯 JS；
 *   · .docx/.xlsx/.pptx    纯 JS（ZIP + XML，见 office.js）；
 *   · .pdf                 纯 JS 尝试抽文字层；不足时用插件自带的
 *                          ocr_windows.ps1（Windows 自带 PDF 渲染 + OCR）兜底；
 *   · .png/.jpg/.jpeg/.webp 交给内置小代理做图片理解（不可用时用同一 OCR 脚本）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { extractOffice, extractOfficeFormulas } from './office.js'
import { extractPdfText, ocrAvailable, pdfExtractorAvailability, runBundledPdftotext, runWindowsOcr } from './pdf.js'
import { extractFormulaLines, latexifyFormulaLines, mathmlToLatex, normalizeLatex } from './formulas.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const SUPPORTED_EXTENSIONS = [
  '.md', '.markdown', '.txt', '.text', '.html', '.htm', '.csv',
  '.pdf', '.docx', '.xlsx', '.pptx',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff',
]

const TEXT_EXTS = new Set(['.md', '.markdown', '.txt', '.text', '.csv'])
const HTML_EXTS = new Set(['.html', '.htm'])
const OFFICE_EXTS = new Set(['.docx', '.xlsx', '.pptx'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff'])
const MAX_TEXT_CHARS = 8 * 1024 * 1024
const MAX_FILE_BYTES = 100 * 1024 * 1024

const IMAGE_MEDIA = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
}

function decodeEntities(text) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
    hellip: '…', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', times: '×',
  }
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)) } catch { return _m }
    })
    .replace(/&#(\d+);/g, (_m, num) => {
      try { return String.fromCodePoint(Number(num)) } catch { return _m }
    })
    .replace(/&([a-z]+);/gi, (match, name) => (named[name.toLowerCase()] !== undefined ? named[name.toLowerCase()] : match))
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ''))
}

/** HTML → 粗略 Markdown 文本（标题/段落/列表/表格单元格）。 */
export function htmlToText(html) {
  let text = String(html || '')
  const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? stripTags(titleMatch[1]).replace(/\s+/g, ' ').trim() : null
  text = text.replace(/<!--[\s\S]*?-->/g, '')
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '')
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '')
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
  text = text.replace(/<head[\s\S]*?<\/head>/gi, '')
  // MathML 在去标签前转成 LaTeX，否则公式结构会丢失。
  text = text.replace(/<math\b[^>]*>[\s\S]*?<\/math>/gi, (mathml) => mathmlToLatex(mathml))
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, content) => {
    const clean = stripTags(content).replace(/\s+/g, ' ').trim()
    return clean === '' ? '\n' : `\n\n${'#'.repeat(Number(level))} ${clean}\n\n`
  })
  text = text.replace(/<li[^>]*>/gi, '\n- ')
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre|table)>/gi, '\n')
  text = text.replace(/<(td|th)[^>]*>/gi, ' | ')
  text = text.replace(/<[^>]+>/g, '')
  text = decodeEntities(text)
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n')
  text = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim()
  text = normalizeLatex(text)
  return { text, title }
}

function titleFromText(text, fallback) {
  const heading = String(text || '').match(/^#\s+(.+)$/m)
  if (heading) return heading[1].trim().slice(0, 160)
  const first = String(text || '').split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '')
  if (first && first.length <= 160) return first
  return fallback
}

function clampText(text, warnings) {
  const value = String(text || '')
  if (value.length <= MAX_TEXT_CHARS) return value
  warnings.push(`文本超过 ${Math.round(MAX_TEXT_CHARS / 1024 / 1024)} MB，已截断`)
  return value.slice(0, MAX_TEXT_CHARS)
}

/** 各种提取器是否可用（全部随插件内置，PDF OCR 依赖 Windows 自带能力）。 */
export function extractorAvailability() {
  const pdf = pdfExtractorAvailability()
  return {
    pdf: pdf.text,
    office: true,
    officecli: bundledOfficecli() !== null,
    html: true,
    bundle: pdf.bundled,
    ocr: pdf.ocr,
    image: true,
  }
}

/** 随包 officecli（Windows x64）；用于 Office 的更高保真文本提取。 */
export function bundledOfficecli() {
  if (process.platform !== 'win32') return null
  const candidate = path.join(HERE, '..', 'vendor', 'officecli', 'officecli.exe')
  try { return fs.statSync(candidate).isFile() ? candidate : null } catch { return null }
}

function runOfficecli(file, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const executable = bundledOfficecli()
    if (executable === null) { reject(new Error('插件内没有 officecli')); return }
    execFile(executable, ['view', file, 'text', '--json'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
    }, (error, stdout) => {
      const done = (result, failure) => {
        // 等 close 真正结束再返回，避免调用方删除临时目录时被 resident 锁住。
        execFile(executable, ['close', file], { windowsHide: true, timeout: 30000 }, () => {
          if (failure) reject(failure)
          else resolve(result)
        })
      }
      if (error) { done(null, error); return }
      try {
        const parsed = JSON.parse(String(stdout || '').trim())
        const elements = parsed && parsed.data && Array.isArray(parsed.data.elements) ? parsed.data.elements : []
        const text = elements
          .map((element) => (element && typeof element.text === 'string' ? element.text.trim() : ''))
          .filter(Boolean)
          .join('\n')
        done({ text, title: null }, null)
      } catch (parseError) {
        done(null, parseError)
      }
    })
  })
}

/**
 * 提取一个文件的文本/图片信息。
 * @param file - 绝对/相对文件路径。
 * @param options.maxBytes - 单文件上限（默认 100 MiB）。
 * @returns {ok, kind:'text'|'image', format, text, title, warnings, meta}
 */
export async function extractDocument(file, options = {}) {
  const maxBytes = Math.max(1, Number(options.maxBytes) || MAX_FILE_BYTES)
  let stat
  try { stat = await fs.promises.lstat(file) } catch { throw new Error(`找不到文件：${file}`) }
  if (stat.isSymbolicLink()) throw new Error('不允许提取符号链接')
  if (!stat.isFile()) throw new Error(`不是文件：${file}`)
  if (stat.size > maxBytes) throw new Error(`文件超过上限 ${Math.round(maxBytes / 1024 / 1024)} MB：${path.basename(file)}`)
  const ext = path.extname(file).toLowerCase()
  if (!SUPPORTED_EXTENSIONS.includes(ext)) throw new Error(`不支持的格式：${ext || '(无扩展名)'}`)
  const warnings = []
  const fallbackTitle = path.basename(file, ext)
  let text = ''
  let title = null
  let extractor = 'native'
  let kind = 'text'
  let mediaType = null
  let meta = { bytes: stat.size }

  if (TEXT_EXTS.has(ext)) {
    text = normalizeLatex(await fs.promises.readFile(file, 'utf8'))
    title = titleFromText(text, fallbackTitle)
    extractor = 'text'
  } else if (HTML_EXTS.has(ext)) {
    const html = await fs.promises.readFile(file, 'utf8')
    const converted = htmlToText(html)
    text = converted.text
    title = converted.title || titleFromText(text, fallbackTitle)
    extractor = 'html'
  } else if (OFFICE_EXTS.has(ext)) {
    const buffer = await fs.promises.readFile(file)
    text = ''
    if (bundledOfficecli() !== null) {
      try {
        const cli = await runOfficecli(file)
        if (String(cli.text || '').trim() !== '') {
          text = cli.text
          extractor = 'officecli'
        }
      } catch (error) {
        warnings.push(`随包 officecli 提取失败，回退纯 JS：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (String(text || '').trim() === '') {
      const office = extractOffice(buffer, ext)
      text = office.text
      title = office.title || null
      extractor = 'office-js'
      meta = { ...meta, ...office.meta }
    }
    // docx 纯 JS 已在段落内嵌入 OMML；officecli/pptx 这里再补一次公式块。
    if (extractor !== 'office-js' || ext === '.pptx') {
      const officeFormulas = extractOfficeFormulas(buffer, ext)
      if (officeFormulas.length > 0) {
        text += '\n\n## 公式（LaTeX）\n' + officeFormulas.map((formula) => `- ${formula}`).join('\n')
        meta = { ...meta, officeFormulas: officeFormulas.length }
      }
    }
    title = title || titleFromText(text, fallbackTitle)
  } else if (ext === '.pdf') {
    const buffer = await fs.promises.readFile(file)
    text = ''
    if (pdfExtractorAvailability().bundled) {
      try {
        text = await runBundledPdftotext(file)
        extractor = 'bundled-pdftotext'
      } catch (error) {
        warnings.push(`随包 pdftotext 失败，改用纯 JS：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (String(text || '').trim() === '') {
      text = extractPdfText(buffer)
      extractor = 'pdf-js'
    }
    if (text.trim().length < 40) {
      if (ocrAvailable()) {
        try {
          const ocrText = await runWindowsOcr(file, 'pdf')
          if (String(ocrText || '').trim() !== '') {
            text = ocrText
            extractor = 'windows-ocr'
            warnings.push('PDF 文字层不足，已用插件内置的 Windows OCR 提取')
          }
        } catch (error) {
          warnings.push(`PDF OCR 兜底失败：${error instanceof Error ? error.message : String(error)}`)
        }
      } else {
        warnings.push('PDF 文字层不足，且当前系统没有可用的 OCR；可能是扫描版 PDF')
      }
    }
    text = normalizeLatex(text)
    const pdfFormulas = extractFormulaLines(text)
    if (pdfFormulas.length > 0) meta = { ...meta, formulaLines: pdfFormulas }
    text = latexifyFormulaLines(text)
    title = titleFromText(text, fallbackTitle)
  } else if (IMAGE_EXTS.has(ext)) {
    kind = 'image'
    mediaType = IMAGE_MEDIA[ext]
    title = fallbackTitle
    extractor = 'image'
    text = ''
  }

  text = clampText(text, warnings)
  if (kind === 'text' && text.trim() === '') warnings.push('提取结果为空')
  const formulas = Array.isArray(meta.formulaLines) ? meta.formulaLines : extractFormulaLines(text)
  return {
    ok: true,
    kind,
    format: ext.replace(/^\./, ''),
    mediaType,
    text,
    title,
    warnings,
    meta: { ...meta, extractor, chars: text.length, file, formulas },
  }
}

export { runWindowsOcr }
