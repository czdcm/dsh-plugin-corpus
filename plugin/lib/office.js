/**
 * dsh-plugin-corpus — Office 文本提取（v1.3，纯 JS）。
 *
 * docx/xlsx/pptx 都是 ZIP + XML；用内置 zip.js 读条目，再用轻量 XML 文本
 * 抽取（不引入 DOM/XML 库）。只取正文/表格/幻灯片文本，不做版式还原。
 */
import { readZip } from './zip.js'
import { ommlToLatex } from './formulas.js'

const OMML_BLOCK = /<m:oMathPara\b[^>]*>[\s\S]*?<\/m:oMathPara>|<m:oMath\b[^>]*>[\s\S]*?<\/m:oMath>/g

function inlineDocxText(fragment) {
  const formulas = []
  const stripped = String(fragment || '').replace(OMML_BLOCK, (block) => {
    const latex = ommlToLatex(block)
    formulas.push(latex)
    return `<w:t>@@FORMULA_${formulas.length - 1}@@</w:t>`
  })
  let text = textOf(stripped).trim()
  text = text.replace(/@@FORMULA_(\d+)@@/g, (_match, index) => {
    const latex = formulas[Number(index)] || ''
    if (latex === '') return ''
    return /\$\$[\s\S]*\$\$|^\$[^$]+\$$/.test(latex) ? latex : `$${latex}$`
  })
  return text
}

function formulaBlocks(xml) {
  const formulas = []
  for (const match of String(xml || '').matchAll(OMML_BLOCK)) {
    const latex = ommlToLatex(match[0])
    if (latex !== '') formulas.push(/\$\$[\s\S]*\$\$|^\$[^$]+\$$/.test(latex) ? latex : `$$${latex}$$`)
  }
  return formulas
}

function xmlUnescape(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)) } catch { return '' }
    })
    .replace(/&#(\d+);/g, (_m, num) => {
      try { return String.fromCodePoint(Number(num)) } catch { return '' }
    })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

function textOf(fragment) {
  const parts = []
  const regexp = /<[^>]*:?t\b[^>]*>([\s\S]*?)<\/[^>]*:?t>/g
  let match
  while ((match = regexp.exec(String(fragment || ''))) !== null) parts.push(xmlUnescape(match[1]))
  return parts.join('')
}

function coreTitle(entries) {
  const core = entries.get('docProps/core.xml')
  if (!core) return null
  const match = core.toString('utf8').match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)
  return match ? xmlUnescape(match[1]).trim() || null : null
}

function headingLevel(style) {
  if (!style) return 0
  const normalized = String(style).toLowerCase()
  const match = normalized.match(/heading\s*([1-6])/) || normalized.match(/标题\s*([1-6])/)
  if (match) return Number(match[1])
  if (normalized === 'title' || normalized === '标题') return 1
  return 0
}

function docxTable(inner) {
  const rows = []
  const rowRegexp = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g
  let rowMatch
  while ((rowMatch = rowRegexp.exec(inner)) !== null) {
    const cells = []
    const cellRegexp = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g
    let cellMatch
    while ((cellMatch = cellRegexp.exec(rowMatch[1])) !== null) cells.push(inlineDocxText(cellMatch[1]))
    rows.push(cells.join(' | '))
  }
  return rows
}

function docxParagraph(inner) {
  const styleMatch = inner.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/)
  const level = headingLevel(styleMatch ? styleMatch[1] : '')
  const text = inlineDocxText(inner)
  if (text === '') return ''
  return level > 0 ? `${'#'.repeat(level)} ${text}` : text
}

export function extractDocx(buffer) {
  const entries = readZip(buffer)
  const document = entries.get('word/document.xml')
  if (!document) throw new Error('docx 缺少 word/document.xml')
  const xml = document.toString('utf8')
  const blocks = []
  const regexp = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>|<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/g
  let match
  let firstHeading = null
  while ((match = regexp.exec(xml)) !== null) {
    if (match[2] !== undefined) {
      const rows = docxTable(match[2])
      if (rows.length > 0) blocks.push(rows.join('\n'))
    } else {
      const line = docxParagraph(match[1])
      if (line === '') continue
      if (firstHeading === null && line.startsWith('#')) firstHeading = line.replace(/^#+\s*/, '')
      blocks.push(line)
    }
  }
  return {
    text: blocks.join('\n\n').trim(),
    title: coreTitle(entries) || firstHeading,
    meta: { paragraphs: blocks.length },
  }
}

function sharedStrings(entries) {
  const entry = entries.get('xl/sharedStrings.xml')
  if (!entry) return []
  const xml = entry.toString('utf8')
  const values = []
  const regexp = /<si\b[^>]*>([\s\S]*?)<\/si>/g
  let match
  while ((match = regexp.exec(xml)) !== null) values.push(textOf(match[1]))
  return values
}

function relsMap(entries, name) {
  const entry = entries.get(name)
  const map = new Map()
  if (!entry) return map
  const xml = entry.toString('utf8')
  const regexp = /<Relationship\b[^>]*\/>/g
  let match
  while ((match = regexp.exec(xml)) !== null) {
    const tag = match[0]
    const id = (tag.match(/\bId="([^"]+)"/) || [])[1]
    const target = (tag.match(/\bTarget="([^"]+)"/) || [])[1]
    if (id && target) map.set(id, target)
  }
  return map
}

function normalizeSheetTarget(target) {
  let value = String(target || '').replace(/\\/g, '/')
  if (value.startsWith('/')) return value.slice(1)
  if (value.startsWith('xl/')) return value
  return 'xl/' + value.replace(/^\.\//, '')
}

function worksheetRows(xml, shared) {
  const rows = []
  const rowRegexp = /<row\b[^>]*>([\s\S]*?)<\/row>/g
  let rowMatch
  while ((rowMatch = rowRegexp.exec(xml)) !== null) {
    const cells = []
    const cellRegexp = /<c\b([^>]*)>([\s\S]*?)<\/c>/g
    let cellMatch
    while ((cellMatch = cellRegexp.exec(rowMatch[1])) !== null) {
      const attrs = cellMatch[1] || ''
      const body = cellMatch[2] || ''
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || ''
      const valueMatch = body.match(/<v[^>]*>([\s\S]*?)<\/v>/)
      const inlineMatch = body.match(/<is\b[^>]*>([\s\S]*?)<\/is>/)
      let value = ''
      if (type === 's' && valueMatch) value = shared[Number(xmlUnescape(valueMatch[1]))] || ''
      else if (type === 'inlineStr' && inlineMatch) value = textOf(inlineMatch[1])
      else if (valueMatch) value = xmlUnescape(valueMatch[1])
      else if (inlineMatch) value = textOf(inlineMatch[1])
      cells.push(String(value).replace(/[\r\n]+/g, ' ').trim())
    }
    if (cells.some((cell) => cell !== '')) rows.push(cells.join(' | '))
  }
  return rows
}

export function extractXlsx(buffer) {
  const entries = readZip(buffer)
  const shared = sharedStrings(entries)
  const workbook = entries.get('xl/workbook.xml')
  if (!workbook) throw new Error('xlsx 缺少 xl/workbook.xml')
  const workbookXml = workbook.toString('utf8')
  const rels = relsMap(entries, 'xl/_rels/workbook.xml.rels')
  const sheets = []
  const sheetRegexp = /<sheet\b[^>]*\/>/g
  let sheetMatch
  while ((sheetMatch = sheetRegexp.exec(workbookXml)) !== null) {
    const tag = sheetMatch[0]
    const name = (tag.match(/\bname="([^"]*)"/) || [])[1] || 'Sheet'
    const rid = (tag.match(/\br:id="([^"]+)"/) || [])[1]
    const target = rid ? rels.get(rid) : null
    if (target) sheets.push({ name: xmlUnescape(name), target: normalizeSheetTarget(target) })
  }
  const blocks = []
  let firstSheet = null
  for (const sheet of sheets) {
    const entry = entries.get(sheet.target)
    if (!entry) continue
    const rows = worksheetRows(entry.toString('utf8'), shared)
    if (rows.length === 0) continue
    if (firstSheet === null) firstSheet = sheet.name
    blocks.push(`## Sheet: ${sheet.name}`, ...rows)
  }
  return {
    text: blocks.join('\n').trim(),
    title: coreTitle(entries) || firstSheet,
    meta: { sheets: sheets.map((sheet) => sheet.name) },
  }
}

export function extractPptx(buffer) {
  const entries = readZip(buffer)
  const presentation = entries.get('ppt/presentation.xml')
  if (!presentation) throw new Error('pptx 缺少 ppt/presentation.xml')
  const rels = relsMap(entries, 'ppt/_rels/presentation.xml.rels')
  const xml = presentation.toString('utf8')
  const ids = []
  const idRegexp = /<p:sldId\b[^>]*\/>/g
  let idMatch
  while ((idMatch = idRegexp.exec(xml)) !== null) {
    const rid = (idMatch[0].match(/\br:id="([^"]+)"/) || [])[1]
    if (rid) ids.push(rid)
  }
  const blocks = []
  let firstText = null
  ids.forEach((rid, index) => {
    const target = rels.get(rid)
    if (!target) return
    let name = target.replace(/\\/g, '/')
    if (name.startsWith('/')) name = name.slice(1)
    else if (!name.startsWith('ppt/')) name = 'ppt/' + name.replace(/^\.\//, '')
    const entry = entries.get(name)
    if (!entry) return
    const slideXml = entry.toString('utf8')
    const texts = []
    const textRegexp = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g
    let textMatch
    while ((textMatch = textRegexp.exec(slideXml)) !== null) {
      const value = xmlUnescape(textMatch[1]).trim()
      if (value !== '') texts.push(value)
    }
    if (texts.length === 0) return
    if (firstText === null) firstText = texts[0]
    blocks.push(`## Slide ${index + 1}`, ...texts)
  })
  return {
    text: blocks.join('\n').trim(),
    title: coreTitle(entries) || firstText,
    meta: { slides: ids.length },
  }
}

export function extractOffice(buffer, ext) {
  const format = String(ext || '').toLowerCase().replace(/^\./, '')
  if (format === 'docx') return { ...extractDocx(buffer), format }
  if (format === 'xlsx') return { ...extractXlsx(buffer), format }
  if (format === 'pptx') return { ...extractPptx(buffer), format }
  throw new Error(`不支持的 Office 格式：${format}`)
}

/** 抽取 xlsx 单元格公式（含 Sheet!Cell 与原始公式文本）。 */
export function extractXlsxFormulas(buffer) {
  const entries = readZip(buffer)
  const workbook = entries.get('xl/workbook.xml')
  if (!workbook) return []
  const workbookXml = workbook.toString('utf8')
  const rels = relsMap(entries, 'xl/_rels/workbook.xml.rels')
  const sheets = []
  const sheetRegexp = /<sheet\b[^>]*\/>/g
  let sheetMatch
  while ((sheetMatch = sheetRegexp.exec(workbookXml)) !== null) {
    const tag = sheetMatch[0]
    const name = xmlUnescape((tag.match(/\bname="([^"]*)"/) || [])[1] || 'Sheet')
    const rid = (tag.match(/\br:id="([^"]+)"/) || [])[1]
    const target = rid ? rels.get(rid) : null
    if (target) sheets.push({ name, target: normalizeSheetTarget(target) })
  }
  const formulas = []
  for (const sheet of sheets) {
    const entry = entries.get(sheet.target)
    if (!entry) continue
    const xml = entry.toString('utf8')
    const cellRegexp = /<c\b([^>]*)>([\s\S]*?)<\/c>/g
    let cellMatch
    while ((cellMatch = cellRegexp.exec(xml)) !== null) {
      const attrs = cellMatch[1]
      const ref = (attrs.match(/\br="([^"]+)"/) || [])[1]
      if (!ref) continue
      const formula = cellMatch[2].match(/<f\b[^>]*>([\s\S]*?)<\/f>/)
      if (!formula) continue
      const value = xmlUnescape(formula[1]).trim()
      if (value !== '') formulas.push(`${sheet.name}!${ref}: =${value}`)
    }
  }
  return formulas
}

/** 单独抽取 Office 内嵌公式（docx OMML / pptx 中嵌入的 OMML）。 */
export function extractOfficeFormulas(buffer, ext) {
  const format = String(ext || '').toLowerCase().replace(/^\./, '')
  const entries = readZip(buffer)
  const formulas = new Set()
  if (format === 'docx') {
    const document = entries.get('word/document.xml')
    if (document) for (const formula of formulaBlocks(document.toString('utf8'))) formulas.add(formula)
  } else if (format === 'pptx') {
    for (const [name, entry] of entries) {
      if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue
      for (const formula of formulaBlocks(entry.toString('utf8'))) formulas.add(formula)
    }
  }
  return [...formulas]
}
