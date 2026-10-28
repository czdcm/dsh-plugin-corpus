/**
 * dsh-plugin-corpus — 文档结构目录（outline）与目录卡片（catalog）。
 *
 * 目标：导入时/首次访问时为每篇 processed 文档生成一份带行号的章节索引，
 * 让模型先看“第几行有什么”，再用 corpus_read 精确读原文。
 *
 * 索引不进入检索分块，存放在 <CORPUS_ROOT>/.corpus/outlines/<hash>.json；
 * 兼容早期放在 processed 旁边的 <name>.outline.json 试点文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { listDocs } from './engine.js'

export const OUTLINE_VERSION = 1
const OUTLINE_DIR = '.corpus/outlines'
const MAX_OUTLINE_BYTES = 2 * 1024 * 1024
const SUMMARY_CHARS = 360

function hashOf(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 20)
}

function safeText(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

function safeRel(relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (rel === '' || rel.split('/').some((part) => part === '' || part === '.' || part === '..' || part === 'originals' || part === '.corpus')) {
    throw new Error('path 必须是语料根内的 processed 文件')
  }
  return rel
}

function generatePath(root, relPath) {
  return path.join(root, OUTLINE_DIR, hashOf(relPath) + '.json')
}

/** 旧版试点目录：与 processed 文件同目录的 <name>.outline.json。 */
export function legacyOutlinePath(root, relPath) {
  const rel = safeRel(relPath)
  const abs = path.join(root, rel)
  return path.join(path.dirname(abs), path.basename(abs, path.extname(abs)) + '.outline.json')
}

function outlineAbs(root, relPath) {
  const legacy = legacyOutlinePath(root, relPath)
  if (fs.existsSync(legacy)) return legacy
  return generatePath(root, relPath)
}

export function outlinePath(root, relPath) {
  return outlineAbs(root, relPath)
}

function validOutline(value, relPath) {
  if (!value || typeof value !== 'object') return false
  if (typeof value.lineCount !== 'number' || !Array.isArray(value.chapters)) return false
  const expected = safeRel(relPath)
  const stored = String(value.processedPath || value.path || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (stored === '') return true
  return stored === expected || stored.endsWith('/' + expected) || expected.endsWith('/' + stored)
}

export function readOutline(root, relPath) {
  try {
    const rel = safeRel(relPath)
    const file = outlineAbs(root, rel)
    const stat = fs.statSync(file)
    if (stat.size > MAX_OUTLINE_BYTES) return null
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return validOutline(parsed, rel) ? parsed : null
  } catch {
    return null
  }
}

function stripFrontMatter(text) {
  return String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

function firstBodyLine(lines, from, end) {
  for (let index = from; index < Math.min(end, lines.length); index++) {
    const raw = lines[index]
    const line = raw.replace(/\f/g, '').trim()
    if (line === '' || /^#{1,6}\s+/.test(line)) continue
    if (/^>/.test(line) || /^---$/.test(line) || /^```/.test(line)) continue
    if (/^(\$\$|\\\[|\\\()/.test(line)) continue
    if (/^\|?[-:\s|]+\|?$/.test(line)) continue
    if (/^\d+\s+Chapter\b|^Chapter\b/i.test(line)) continue
    if (/^\d+(?:\.\d+)+\s+/.test(line)) continue
    if (line.length < 24) continue
    return line
  }
  return ''
}

function summaryFor(lines, startLine, endLine) {
  // 优先使用正文里的 “abstract of the chapter” 段落；否则取第一段正文。
  const from = Math.max(0, startLine - 1)
  const to = Math.min(lines.length, endLine)
  for (let index = from; index < Math.min(to, from + 80); index++) {
    if (!/the abstract of the chapter/i.test(lines[index])) continue
    const para = []
    for (let cursor = index + 1; cursor < Math.min(to, index + 24); cursor++) {
      const line = lines[cursor].replace(/\f/g, '').trim()
      if (line === '') {
        if (para.length > 0) break
        continue
      }
      if (/^#{1,6}\s+|^\d+(?:\.\d+)+\s+/.test(line)) break
      para.push(line)
      if (para.join(' ').length > SUMMARY_CHARS) break
    }
    if (para.length > 0) return safeText(para.join(' '), SUMMARY_CHARS)
  }
  const line = firstBodyLine(lines, from, to)
  return safeText(line, SUMMARY_CHARS)
}

function keywordsFor(title, summary) {
  const stop = new Set(('the of and to in for a an is are by with as on its their this that from under between into using used can be it or at which such more most other than these both each will four questions chapter book also may not has have been were was one two three').split(' '))
  const words = String(title + ' ' + summary).toLowerCase().match(/[a-z][a-z-]{3,}/g) || []
  const freq = new Map()
  for (const word of words) {
    if (stop.has(word)) continue
    freq.set(word, (freq.get(word) || 0) + 1)
  }
  return [...freq.entries()].sort((left, right) => right[1] - left[1]).slice(0, 6).map(([word]) => word)
}

function headingCandidates(lines) {
  const headings = []
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]
    const cleaned = raw.replace(/\f/g, '').trim()
    const markdown = cleaned.match(/^(#{1,6})\s+(.+)$/)
    if (markdown) {
      headings.push({ line: index + 1, level: markdown[1].length, title: safeText(markdown[2], 180), markdown: true })
      continue
    }
    const chapter = cleaned.match(/^(?:CHAPTER|Chapter)\s+(\d+)?\s*(.*)$/)
    if (chapter && cleaned.length < 160) {
      headings.push({ line: index + 1, level: 1, title: safeText(cleaned, 180), chapter: true })
      continue
    }
    const numbered = cleaned.match(/^(\d+(?:\.\d+){1,3})\s+([A-Z\u4e00-\u9fff][^\n]{2,160})$/)
    if (numbered && cleaned.length < 190) {
      const parts = numbered[1].split('.')
      headings.push({ line: index + 1, level: Math.min(4, parts.length + 1), title: safeText(numbered[1] + ' ' + numbered[2], 180), numbered: true })
    }
  }
  // 同一行/同一标题的重复页眉只保留第一次出现。
  const seen = new Set()
  return headings.filter((heading) => {
    const key = heading.title.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function makeNode(lines, heading, endLine) {
  const summary = summaryFor(lines, heading.line, endLine)
  return {
    id: 'h' + heading.line,
    number: heading.numbered ? String(heading.title).split(/\s+/)[0] : undefined,
    title: heading.title,
    level: heading.level,
    startLine: heading.line,
    endLine,
    summary,
    keywords: keywordsFor(heading.title, summary),
    sections: [],
  }
}

function fallbackChapters(lines, lineCount, title) {
  const chapters = []
  const size = Math.max(120, Math.min(400, Math.ceil(lineCount / 40)))
  for (let start = 1, index = 0; start <= lineCount; start += size, index++) {
    const end = Math.min(lineCount, start + size - 1)
    const heading = { line: start, level: 1, title: index === 0 ? title : `Part ${index + 1}` }
    chapters.push(makeNode(lines, heading, end))
  }
  return chapters
}

/**
 * 从 Markdown 文本生成结构化目录。只做确定性解析，不猜测不存在的内容。
 * @param {object} options
 * @param {string} options.text - processed Markdown。
 * @param {string} options.relPath - 相对语料根的路径。
 * @param {string} [options.title]
 * @param {string} [options.source]
 * @param {string} [options.collection]
 * @param {string} [options.language]
 * @param {number} [options.pageCount]
 */
export function buildOutline(options = {}) {
  const text = String(options.text || '')
  const relPath = safeRel(options.relPath)
  const lines = text.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const lineCount = Math.max(1, lines.length)
  const title = safeText(options.title || path.basename(relPath).replace(/\.[^.]+$/, ''), 160)
  const headings = headingCandidates(lines)
  let chapters = []

  if (headings.length > 0) {
    // 单个一级标题通常只是文档标题；多个一级标题时，只有标题与文档标题一致才跳过。
    let start = 0
    if (headings.length > 1 && headings[0].level === 1) {
      const first = String(headings[0].title || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')
      const docTitle = String(title || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')
      const h1Count = headings.filter((heading) => heading.level === 1).length
      if (h1Count === 1 || (first !== '' && (first === docTitle || docTitle.includes(first) || first.includes(docTitle)))) start = 1
    }
    const rest = headings.slice(start)
    const chapterLevel = rest.length > 0 ? Math.min(...rest.map((heading) => heading.level)) : 1
    for (let index = start; index < headings.length; index++) {
      const heading = headings[index]
      if (heading.level !== chapterLevel) continue
      const nextChapter = headings.slice(index + 1).find((item) => item.level === chapterLevel)
      const chapterEnd = nextChapter ? Math.max(heading.line, nextChapter.line - 1) : lineCount
      const chapter = makeNode(lines, heading, chapterEnd)
      for (let cursor = index + 1; cursor < headings.length; cursor++) {
        const section = headings[cursor]
        if (section.level === chapterLevel) break
        if (section.level <= chapterLevel) continue
        const nextHeading = headings[cursor + 1]
        const sectionEnd = nextHeading ? Math.max(section.line, Math.min(chapterEnd, nextHeading.line - 1)) : chapterEnd
        if (sectionEnd >= section.line) chapter.sections.push(makeNode(lines, section, sectionEnd))
      }
      chapters.push(chapter)
    }
  }

  if (chapters.length === 0) chapters = fallbackChapters(lines, lineCount, title)
  // 补上章末尾行，避免空段或越界。
  for (let index = 0; index < chapters.length; index++) {
    chapters[index].startLine = Math.max(1, Math.min(chapters[index].startLine, lineCount))
    chapters[index].endLine = Math.max(chapters[index].startLine, Math.min(chapters[index].endLine, lineCount))
    for (const section of chapters[index].sections) {
      section.startLine = Math.max(chapters[index].startLine, Math.min(section.startLine, chapters[index].endLine))
      section.endLine = Math.max(section.startLine, Math.min(section.endLine, chapters[index].endLine))
    }
  }
  const summary = chapters.length > 0 ? (chapters[0].summary || '') : ''
  return {
    version: OUTLINE_VERSION,
    docId: hashOf(relPath),
    title,
    collection: options.collection || relPath.split('/')[0] || '',
    processedPath: relPath,
    source: options.source || '',
    language: options.language || '',
    lineCount,
    pageCount: Number(options.pageCount) || null,
    generatedAt: new Date().toISOString(),
    generator: 'deterministic-outline-v1',
    summary,
    chapters,
  }
}

export function writeOutline(root, relPath, options = {}) {
  const rel = safeRel(relPath)
  const text = typeof options.text === 'string' ? options.text : fs.readFileSync(path.join(root, rel), 'utf8')
  const outline = buildOutline({ ...options, text, relPath: rel })
  const file = generatePath(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(outline, null, 2), 'utf8')
  return outline
}

/** 读取已有目录；不存在时按需生成。生成失败返回 null，不能阻塞读取。 */
export function ensureOutline(root, relPath, options = {}) {
  const existing = readOutline(root, relPath)
  if (existing) return existing
  try {
    return writeOutline(root, relPath, options)
  } catch {
    return null
  }
}

export function outlineBrief(outline) {
  if (!outline) return null
  return {
    path: outline.processedPath,
    title: outline.title,
    lineCount: outline.lineCount,
    pageCount: outline.pageCount,
    chapters: Array.isArray(outline.chapters) ? outline.chapters.length : 0,
    sections: Array.isArray(outline.chapters)
      ? outline.chapters.reduce((sum, chapter) => sum + (Array.isArray(chapter.sections) ? chapter.sections.length : 0), 0)
      : 0,
    summary: outline.summary || (outline.chapters && outline.chapters[0] && (outline.chapters[0].abstract || outline.chapters[0].summary)) || '',
    keywords: (outline.chapters && outline.chapters[0] && outline.chapters[0].keywords) || [],
  }
}

/** 生成文档卡片目录；不生成缺失的 outline，避免在 prompt 里做重活。 */
export function catalog(root, collections, options = {}) {
  const limit = Math.max(1, Math.min(1000, Number(options.limit) || 200))
  const listed = listDocs(root, { collections, limit })
  const out = {
    ok: true,
    collections: listed.collections.map((collection) => ({
      name: collection.name,
      docs: collection.docs,
      chunks: collection.chunks,
      indexedAt: collection.indexedAt,
      documents: (collection.files || []).map((file) => {
        const outline = readOutline(root, file.path)
        const brief = outlineBrief(outline)
        return {
          path: file.path,
          title: file.title,
          chunks: file.chunks,
          bytes: file.bytes,
          outline: brief !== null,
          lineCount: brief ? brief.lineCount : null,
          chapters: brief ? brief.chapters : null,
          sections: brief ? brief.sections : null,
          summary: brief ? brief.summary : '',
          keywords: brief ? brief.keywords : [],
        }
      }),
    })),
  }
  return out
}

export function outlinePathFor(root, relPath) {
  return outlineAbs(root, safeRel(relPath))
}

export { stripFrontMatter }
