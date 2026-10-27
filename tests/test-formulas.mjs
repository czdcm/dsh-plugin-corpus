import fs from 'node:fs'
import { extractFormulaLines, mathmlToLatex, normalizeLatex, ommlToLatex } from '../plugin/lib/formulas.js'
import { extractDocument } from '../plugin/lib/extract.js'

let pass = 0
const ok = (label) => { pass += 1; console.log('  PASS ' + label) }
const assert = (condition, message) => { if (!condition) throw new Error('ASSERT: ' + message) }

const inline = mathmlToLatex('<math><mrow><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></mrow></math>')
assert(inline === '$E=mc^{2}$', 'MathML 行内公式应转成 LaTeX，实际 ' + inline)
ok('MathML 行内公式 → $...$')

const display = mathmlToLatex('<math display="block"><mfrac><mn>1</mn><mn>2</mn></mfrac></math>')
assert(display === '$$\\frac{1}{2}$$', 'MathML display 公式应转成 $$...$$，实际 ' + display)
ok('MathML display 公式 → $$...$$')

const omml = ommlToLatex('<m:oMath><m:r><m:t>x</m:t></m:r><m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f></m:oMath>')
assert(omml.includes('\\frac{1}{2}'), 'OMML 分式应转成 \\frac，实际 ' + omml)
ok('OMML 分式 → \\frac')

const normalized = normalizeLatex('已知 \\(a×b≤c\\)，且 $$x=1$$。')
assert(normalized.includes('$a\\times b\\le c$'), 'Unicode 数学符号应在公式内转 LaTeX，实际 ' + normalized)
assert(normalized.includes('$$x=1$$'), '已有 $$...$$ 应保留')
ok('Unicode 数学符号 → LaTeX 命令')

const fenced = normalizeLatex('```\n\\(a×b≤c\\)\n```')
assert(fenced.includes('\\(a×b≤c\\)'), '代码块里的内容不应被公式规范化')
ok('代码块不修改')

const lines = extractFormulaLines('∑ X = 0\n普通说明\n∫ 0 1 f(x) dx = 1')
assert(lines.length >= 2, '应提取至少 2 条公式行，实际 ' + JSON.stringify(lines))
assert(lines[0].startsWith('$$') && lines[0].endsWith('$$'), '公式行应包成 $$...$$')
ok('公式行提取并包成 $$...$$')

const pdf = process.env.CORPUS_TEST_FORMULA_PDF
if (!pdf || !fs.existsSync(pdf)) {
  console.log('  SKIP 真实 PDF 公式回归（设置 CORPUS_TEST_FORMULA_PDF 指向结构力学 PDF）')
} else {
  const extracted = await extractDocument(pdf, { maxBytes: 100 * 1024 * 1024 })
  const formulas = Array.isArray(extracted.meta.formulas) ? extracted.meta.formulas : []
  assert(formulas.length >= 50, '结构力学 PDF 应提取至少 50 条公式，实际 ' + formulas.length)
  assert(extracted.text.includes('$$'), 'PDF 正文应包含 LaTeX 公式块')
  assert(extracted.text.includes('\\sum') || extracted.text.includes('\\int'), 'PDF 公式应包含 \\sum 或 \\int')
  assert((extracted.text.match(/\$\$/g) || []).length >= 100, 'PDF 应保留大量公式块')
  console.log(`  PASS 真实 PDF 公式保留（${formulas.length} 条，extractor=${extracted.meta.extractor}）`)
  ok('真实 PDF 公式回归')
}

console.log('')
console.log('全部通过: ' + pass + ' 项（公式识别）')
