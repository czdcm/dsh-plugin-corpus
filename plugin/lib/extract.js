/**
 * dsh-plugin-corpus — 文档提取（v1.4.3，可随插件整体搬走）。
 *
 * 不依赖本机安装的 Python；Office / PDF 的高保真提取依赖随包二进制（官方完整包均包含）：
 *   · .md/.txt/.csv/.html  纯 JS；
 *   · .docx/.xlsx/.pptx    officecli 优先，缺失/失败时回退纯 JS（ZIP + XML，见 office.js）；
 *   · .pdf                 随包 pdftotext（vendor/pdftotext）；无文字层的扫描件用
 *                          ocr_windows.ps1（Windows 自带 PDF 渲染 + OCR）兜底；
 *   · .png/.jpg/.jpeg/.webp 交给内置小代理做图片理解（不可用时用同一 OCR 脚本）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { extractOffice, extractOfficeFormulas, extractXlsxFormulas } from './office.js'
import { compressPageRanges, isUsablePdfText, mergePdfPageTexts, needsOcrPage, ocrAvailable, parseOcrPages, pdfExtractorAvailability, pdfTextQuality, runBundledPdftotext, runWindowsOcr, splitPdfPages } from './pdf.js'
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
const MAX_FILE_BYTES = 256 * 1024 * 1024

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
  const first = String(text || '').split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '' && !/^---\s*Page\s+\d+/i.test(line))
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

function parseCliJson(stdout) {
  const text = String(stdout || '').replace(/^\uFEFF/, '').trim()
  if (text === '') return null
  try { return JSON.parse(text) } catch { return null }
}

function runOfficeCliCommand(executable, args, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      encoding: 'utf8',
      maxBuffer: 96 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
      env,
    }, (error, stdout) => {
      if (error) { reject(error); return }
      resolve(parseCliJson(stdout))
    })
  })
}

function annotatedSlides(content) {
  const result = new Map()
  const text = String(content || '')
  const regexp = /\[\/slide\[(\d+)\]\]([\s\S]*?)(?=\[\/slide\[\d+\]\]|$)/g
  let match
  while ((match = regexp.exec(text)) !== null) {
    const index = Number(match[1])
    const lines = match[2].split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    result.set(index, lines)
  }
  return result
}

function cliTextOf(data, ext) {
  if (!data) return ''
  if (ext === '.pptx') {
    const slides = data.data && Array.isArray(data.data.slides) ? data.data.slides : []
    return slides.map((slide) => {
      const texts = Array.isArray(slide.texts) ? slide.texts : []
      return `Slide ${slide.index}\n${texts.join('\n')}`
    }).join('\n\n')
  }
  const elements = data.data && Array.isArray(data.data.elements) ? data.data.elements : []
  return elements.map((element) => element && typeof element.text === 'string' ? element.text : '').filter(Boolean).join('\n')
}

function pptxDigest(cli) {
  const data = cli.textData && cli.textData.data ? cli.textData.data : {}
  const outline = cli.outline && cli.outline.data && Array.isArray(cli.outline.data.slides) ? cli.outline.data.slides : []
  const slides = Array.isArray(data.slides) ? data.slides : []
  const annotated = annotatedSlides(cli.annotated && cli.annotated.data ? cli.annotated.data.content : '')
  const connectorCounts = new Map()
  const connectorSamples = new Map()
  const charts = cli.charts && cli.charts.data && Array.isArray(cli.charts.data.results) ? cli.charts.data.results : []
  for (const result of (cli.connectors && cli.connectors.data && Array.isArray(cli.connectors.data.results) ? cli.connectors.data.results : [])) {
    const match = String(result.path || '').match(/^\/slide\[(\d+)\]/)
    if (!match) continue
    const index = Number(match[1])
    connectorCounts.set(index, (connectorCounts.get(index) || 0) + 1)
    if (!connectorSamples.has(index)) connectorSamples.set(index, result)
  }
  const lines = [`## Office 结构（PowerPoint，共 ${data.totalSlides || slides.length} 页）`, '']
  for (let index = 0; index < slides.length; index++) {
    const slide = slides[index] || {}
    const number = Number(slide.index) || index + 1
    const meta = outline.find((item) => Number(item.index) === number) || {}
    const texts = (Array.isArray(slide.texts) ? slide.texts : [])
      .map((value) => String(value || '').trim())
      .filter((value) => value !== '' && !/^\d{1,3}$/.test(value))
    const structures = (annotated.get(number) || [])
      .filter((line) => /\[(Group|Picture|Table|Chart|Connector|OLE|Diagram|Media)\b/i.test(line))
      .slice(0, 12)
    lines.push(`### Slide ${number}${meta.title ? ' — ' + meta.title : ''}`)
    if (texts.length > 0) lines.push('文本：' + texts.join(' | '))
    const counts = []
    if (meta.textBoxes) counts.push(`文本框 ${meta.textBoxes}`)
    if (meta.pictures) counts.push(`图片 ${meta.pictures}`)
    if (meta.oleObjects) counts.push(`OLE ${meta.oleObjects}`)
    const connectorCount = connectorCounts.get(number) || 0
    if (connectorCount > 0) {
      const sample = connectorSamples.get(number)
      const format = sample && sample.format ? sample.format : {}
      const endpoint = format.width || format.height ? `位置 ${format.x || '?'},${format.y || '?'} 尺寸 ${format.width || '?'}×${format.height || '?'}` : '无坐标'
      counts.push(`连接线 ${connectorCount}（${endpoint}）`)
    }
    const chartCount = charts.filter((item) => String(item.path || '').startsWith(`/slide[${number}]`)).length
    if (chartCount > 0) counts.push(`图表 ${chartCount}`)
    if (counts.length > 0) lines.push('对象：' + counts.join('；'))
    if (structures.length > 0) lines.push('图形关系：\n' + structures.map((line) => '- ' + line).join('\n'))
    lines.push('')
  }
  lines.push('说明：以上是 officecli 的文本/对象树/连接线摘要；“版式缩略图”作为独立图片输入，优先用于判断页面布局与图形逻辑。')
  return lines.join('\n')
}

function docxTablesFromHtml(html) {
  const source = String(html || '')
  const tables = []
  const tableRegexp = /<table\b[^>]*>([\s\S]*?)<\/table>/gi
  let tableMatch
  while ((tableMatch = tableRegexp.exec(source)) !== null) {
    const rows = []
    const rowRegexp = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
    let rowMatch
    while ((rowMatch = rowRegexp.exec(tableMatch[1])) !== null) {
      const cells = []
      const cellRegexp = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi
      let cellMatch
      while ((cellMatch = cellRegexp.exec(rowMatch[1])) !== null) {
        const value = decodeEntities(String(cellMatch[2]).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' '))
          .replace(/\s+/g, ' ').trim()
        if (value !== '') cells.push(value)
      }
      if (cells.length > 0) rows.push(cells.join(' | '))
    }
    if (rows.length > 0) tables.push(rows.join('\n'))
  }
  return tables
}

function docxDigest(cli, ext) {
  const data = cli.textData && cli.textData.data ? cli.textData.data : {}
  const elements = Array.isArray(data.elements) ? data.elements : []
  const lines = ['## Office 结构（Word，officecli 提取）', '', '### 正文']
  for (const element of elements) {
    const text = element && typeof element.text === 'string' ? element.text.trim() : ''
    if (text === '') continue
    if (element.type === 'table') lines.push('', `[${text}]`, '')
    else lines.push(text)
  }
  const tables = docxTablesFromHtml(cli.html && cli.html.data ? cli.html.data : '')
  if (tables.length > 0) {
    lines.push('', '### 表格内容')
    tables.forEach((table, index) => {
      lines.push(`Table ${index + 1}:`, table, '')
    })
  }
  const outline = cli.outline && cli.outline.data ? cli.outline.data : null
  if (outline && Array.isArray(outline.headings) && outline.headings.length > 0) {
    lines.push('### 标题树')
    for (const heading of outline.headings.slice(0, 80)) {
      lines.push(`${'#'.repeat(Math.max(1, Math.min(6, Number(heading.level) || 1)))} ${heading.text || ''}`)
    }
  }
  return lines.join('\n')
}

function xlsxDigest(cli, jsText) {
  const lines = ['## Office 结构（Excel，officecli 提取）', '']
  const outline = cli.outline && cli.outline.data ? cli.outline.data : null
  if (outline && Array.isArray(outline.sheets) && outline.sheets.length > 0) lines.push(`工作表：${outline.sheets.join('、')}`, '')
  lines.push('### 工作表内容（纯 JS 回读）', '', String(jsText || '').trim())
  return lines.join('\n')
}


/**
 * 用随包 officecli 读取 Office：text + annotated/outline/对象关系，PPT 另渲染版式缩略图。
 * TEMP/TMP 指向插件目录下的临时目录，避免 DSH 运行环境的系统 Temp ACL 拒绝。
 */
function runOfficecli(file, ext, timeoutMs = 120000) {
  const executable = bundledOfficecli()
  if (executable === null) return Promise.reject(new Error('插件内没有 officecli'))
  const tempDir = fs.mkdtempSync(path.join(path.dirname(HERE), 'officecli-tmp-'))
  const env = { ...process.env, TEMP: tempDir, TMP: tempDir }
  const invoke = (args, ms = timeoutMs) => runOfficeCliCommand(executable, args, env, ms)
  const close = () => new Promise((resolve) => {
    execFile(executable, ['close', file], { windowsHide: true, timeout: 30000, env }, () => resolve())
  })
  return (async () => {
    try {
      const textData = await invoke(['view', file, 'text', '--json'])
      const annotated = await invoke(['view', file, 'annotated', '--json']).catch(() => null)
      const outline = await invoke(['view', file, 'outline', '--json']).catch(() => null)
      const html = ext === '.docx' ? await invoke(['view', file, 'html', '--json']).catch(() => null) : null
      let connectors = null
      let charts = null
      if (ext === '.pptx') {
        connectors = await invoke(['query', file, 'connector', '--json']).catch(() => null)
        charts = await invoke(['query', file, 'chart', '--json']).catch(() => null)
      }
      let image = null
      if (ext === '.pptx') {
        const imagePath = path.join(tempDir, 'slides-contact-sheet.png')
        try {
          await invoke(['view', file, 'screenshot', '--grid', 'auto', '--screenshot-width', '1600', '-o', imagePath, '--json'])
          if (fs.existsSync(imagePath)) image = await fs.promises.readFile(imagePath)
        } catch { /* 没有渲染能力时仍用对象关系 */ }
      }
      return { textData, annotated, outline, html, connectors, charts, image }
    } finally {
      await close()
      try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结果 */ }
    }
  })()
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
    let officejs = null
    try { officejs = extractOffice(buffer, ext) } catch { /* officecli 主路径失败时再报 */ }
    let cli = null
    if (bundledOfficecli() !== null) {
      try {
        cli = await runOfficecli(file, ext)
        const cliText = cliTextOf(cli.textData, ext)
        if (String(cliText || '').trim() === '') throw new Error('officecli 没有返回可读内容')
        extractor = 'officecli'
        if (ext === '.pptx') {
          text = pptxDigest(cli)
          const firstSlide = cli.textData && cli.textData.data && Array.isArray(cli.textData.data.slides) ? cli.textData.data.slides[0] : null
          const firstText = firstSlide && Array.isArray(firstSlide.texts)
            ? firstSlide.texts.map((value) => String(value || '').trim()).find((value) => value !== '' && !/^\d{1,3}$/.test(value))
            : ''
          if (firstText) title = firstText
        } else if (ext === '.docx') {
          text = docxDigest(cli, ext)
        } else {
          text = xlsxDigest(cli, officejs ? officejs.text : '')
        }
        if (cli.image && cli.image.length > 0) {
          meta.officeVisuals = [{ data: cli.image, mediaType: 'image/png', name: 'slides-contact-sheet.png' }]
        }
        meta = {
          ...meta,
          officecli: {
            annotated: cli.annotated !== null,
            outline: cli.outline !== null,
            connectors: cli.connectors && cli.connectors.data ? cli.connectors.data.matches : 0,
            charts: cli.charts && cli.charts.data ? cli.charts.data.matches : 0,
            rendered: Boolean(cli.image),
          },
        }
      } catch (error) {
        warnings.push(`officecli 提取失败，回退纯 JS：${error instanceof Error ? error.message : String(error)}`)
        cli = null
      }
    } else {
      warnings.push('插件内没有 officecli，Office 使用纯 JS 回退')
    }
    if (String(text || '').trim() === '') {
      if (!officejs) officejs = extractOffice(buffer, ext)
      text = officejs.text
      extractor = 'office-js'
      title = officejs.title || null
      meta = { ...meta, ...officejs.meta }
    }
    title = title || (officejs && officejs.title) || titleFromText(text, fallbackTitle)
    // 所有 Office 格式都补公式块：docx/pptx OMML + xlsx 单元格公式。
    const officeFormulas = extractOfficeFormulas(buffer, ext)
    if (officeFormulas.length > 0) {
      text += '\n\n## 公式（LaTeX）\n' + officeFormulas.map((formula) => `- ${formula}`).join('\n')
      meta = { ...meta, officeFormulas: officeFormulas.length }
    }
    if (ext === '.xlsx') {
      const xlsxFormulas = extractXlsxFormulas(buffer)
      if (xlsxFormulas.length > 0) {
        text += '\n\n## Excel 公式\n' + xlsxFormulas.map((item) => `- ${item}`).join('\n')
        meta = { ...meta, xlsxFormulas: xlsxFormulas.length }
      }
    }
  } else if (ext === '.pdf') {
    const canOcr = ocrAvailable()
    const pdfAvailable = pdfExtractorAvailability()
    text = ''
    let textPages = []
    let pageCount = 0
    let ocrMap = new Map()
    let ocrRuns = 0

    // 第一层：文字层（整本 pdftotext），按 \f 拆页后逐页判断。
    if (pdfAvailable.bundled) {
      try {
        const candidate = await runBundledPdftotext(file)
        textPages = splitPdfPages(candidate)
        pageCount = textPages.length
        const missing = []
        for (let index = 0; index < textPages.length; index++) {
          if (needsOcrPage(textPages[index])) missing.push(index + 1)
        }
        if (missing.length > 0 && canOcr) {
          // 逐页兜底：只为缺文字层/乱码的页跑 OCR，文字页原样保留。
          const pagesSpec = compressPageRanges(missing)
          const timeoutMs = Math.min(30 * 60 * 1000, Math.max(15 * 60 * 1000, missing.length * 1500))
          warnings.push(`PDF 有 ${missing.length}/${pageCount} 页没有可读文字层，仅对这些页使用 OCR`)
          try {
            const stdout = await runWindowsOcr(file, 'pdf', timeoutMs, { pages: pagesSpec })
            const parsed = parseOcrPages(stdout)
            ocrMap = parsed.pages
            ocrRuns = 1
            if (parsed.failures.size > 0) {
              const first = [...parsed.failures.keys()].slice(0, 10).join(', ')
              warnings.push(`有 ${parsed.failures.size} 页 OCR 失败（第 ${first}${parsed.failures.size > 10 ? '…' : ''} 页）`)
            }
          } catch (error) {
            warnings.push(`PDF 逐页 OCR 失败：${error instanceof Error ? error.message : String(error)}`)
          }
        } else if (missing.length > 0) {
          warnings.push(`PDF 有 ${missing.length}/${pageCount} 页没有可读文字层，且当前系统没有可用的 OCR`)
        }
      } catch (error) {
        warnings.push(`随包 pdftotext 失败：${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      // 发布版均带 pdftotext；缺失时只能整本 OCR（或明确失败）。
      warnings.push('插件内没有随包 pdftotext（官方完整包应包含）；PDF 文字层无法提取，改为整本 OCR')
    }

    // 第二层（整体）：没有文字层（pdftotext 缺失/失败）时整本 OCR。
    if (pageCount === 0 && canOcr) {
      try {
        const stdout = await runWindowsOcr(file, 'pdf')
        const parsed = parseOcrPages(stdout)
        ocrMap = parsed.pages
        ocrRuns = 1
        pageCount = Math.max(0, ...[...parsed.pages.keys()], ...[...parsed.failures.keys()])
        if (parsed.failures.size > 0) warnings.push(`有 ${parsed.failures.size} 页 OCR 失败`)
      } catch (error) {
        warnings.push(`PDF OCR 失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const merged = mergePdfPageTexts(textPages, ocrMap, pageCount)
    const mergedText = merged.pages.join('\n\n').trim()
    if (mergedText !== '') text = mergedText
    if (merged.ocrPages > 0) {
      extractor = merged.textPages > 0 ? 'pdf-mixed' : 'windows-ocr'
    } else if (merged.textPages > 0) {
      extractor = 'bundled-pdftotext'
    }
    if (!isUsablePdfText(text)) {
      const detail = pageCount > 0
        ? `（共 ${pageCount} 页：文字层 ${merged.textPages} 页、OCR ${merged.ocrPages} 页、不可读 ${merged.weakPages + merged.emptyPages} 页）`
        : ''
      throw new Error(pdfAvailable.bundled
        ? `PDF 没有可读文字层，且 OCR 不可用或结果不可读${detail}；请检查 PDF 是否为扫描件/加密件`
        : `PDF 文字提取需要随包 pdftotext（官方完整包包含）${detail}；当前安装缺少 vendor/pdftotext，且没有可用的 OCR`)
    }
    const quality = pdfTextQuality(text)
    meta = {
      ...meta,
      pdfQuality: quality,
      pdfPages: {
        total: pageCount,
        text: merged.textPages,
        ocr: merged.ocrPages,
        weak: merged.weakPages,
        empty: merged.emptyPages,
        ocrRuns,
      },
    }
    text = normalizeLatex(text)
    const pdfFormulas = extractFormulaLines(text)
    if (pdfFormulas.length > 0) meta = { ...meta, formulaLines: pdfFormulas }
    text = latexifyFormulaLines(text)
    // 整本 OCR 的第一行常是页眉/标点，不用它当标题；有文字层时仍按正文首行取标题。
    title = merged.textPages > 0 ? titleFromText(text, fallbackTitle) : fallbackTitle
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
