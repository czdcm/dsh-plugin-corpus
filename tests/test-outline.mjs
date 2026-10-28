// 文档结构目录（outline）单元测试：标题层级、行号范围、落盘与按需生成。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildOutline, ensureOutline, outlinePathFor, readOutline, writeOutline } from '../plugin/lib/outline.js'

let pass = 0
const ok = (message) => { pass++; console.log('  PASS ' + message) }
const assert = (condition, message) => { if (!condition) throw new Error('ASSERT: ' + message) }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-outline-'))
try {
  const rel = 'demo/20260101-book/processed/book.md'
  const abs = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const text = [
    '# Structural Mechanics',
    '',
    'The document introduction paragraph is long enough to be used as a summary.',
    '',
    '## Chapter 1 Introduction',
    '',
    'This chapter introduces the basic concepts and analytical models of structural mechanics.',
    '',
    '### 1.1 Structures',
    '',
    'A structure is a frame or skeleton used to carry loads and transmit them to the ground.',
    '',
    '## Chapter 2 Force Method',
    '',
    'The force method analyzes statically indeterminate structures using compatibility equations.',
    '',
    '### 2.1 Degrees of Indeterminacy',
    '',
    'The degree of indeterminacy is the number of redundant restraints in a structure.',
  ].join('\n')
  fs.writeFileSync(abs, text, 'utf8')

  const built = buildOutline({ text, relPath: rel, title: 'Structural Mechanics', collection: 'demo' })
  assert(built.version === 1 && built.lineCount === 19, 'outline version/line count')
  assert(built.chapters.length === 2, 'expected 2 chapters, got ' + built.chapters.length)
  assert(built.chapters[0].title === 'Chapter 1 Introduction', 'chapter title')
  assert(built.chapters[0].sections.length === 1 && built.chapters[0].sections[0].title === '1.1 Structures', 'section title')
  assert(built.chapters[0].startLine === 5 && built.chapters[1].startLine === 13, 'chapter start lines')
  assert(built.chapters[0].sections[0].startLine === 9 && built.chapters[0].sections[0].endLine === 12, 'section line range')
  assert(built.chapters[0].summary.includes('introduces'), 'chapter summary from body')
  ok('buildOutline: heading hierarchy, line ranges, summary')

  const written = writeOutline(root, rel, { text, title: 'Structural Mechanics', collection: 'demo' })
  assert(written.chapters.length === 2, 'writeOutline result')
  assert(fs.existsSync(outlinePathFor(root, rel)), 'outline file exists')
  const loaded = readOutline(root, rel)
  assert(loaded !== null && loaded.chapters[0].title === 'Chapter 1 Introduction', 'readOutline')
  const ensured = ensureOutline(root, rel)
  assert(ensured !== null && ensured.lineCount === built.lineCount, 'ensureOutline reuses existing outline')
  ok('outline persistence, reading and reuse')

  const noHeadings = 'first paragraph without headings.\n\nsecond paragraph of plain text.\n'.repeat(80)
  const fallback = buildOutline({ text: noHeadings, relPath: rel, title: 'Plain book' })
  assert(fallback.chapters.length > 0 && fallback.chapters[0].startLine === 1, 'fallback chunks')
  assert(fallback.chapters.every((chapter) => chapter.endLine >= chapter.startLine), 'fallback line ranges')
  ok('no-heading document falls back to chunk outline')

  const legacyRel = 'demo/legacy/processed/legacy.md'
  const legacyAbs = path.join(root, ...legacyRel.split('/'))
  fs.mkdirSync(path.dirname(legacyAbs), { recursive: true })
  fs.writeFileSync(legacyAbs, '# Legacy\n\nBody.\n', 'utf8')
  const legacyOutline = { ...built, processedPath: legacyRel, title: 'Legacy' }
  fs.writeFileSync(path.join(path.dirname(legacyAbs), 'legacy.outline.json'), JSON.stringify(legacyOutline), 'utf8')
  assert(readOutline(root, legacyRel)?.title === 'Legacy', 'legacy outline path')
  ok('compatible with legacy outline path')

  console.log('\n全部通过: ' + pass + ' 项（目录索引）')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
