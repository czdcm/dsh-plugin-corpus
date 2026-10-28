/**
 * 公式识别与 LaTeX 规范化。
 *
 * 目标：不管导入的是 Markdown/HTML/Office/PDF/图片，processed Markdown 里的
 * 数学内容都尽量落成 LaTeX：
 *   - 行内公式：$...$
 *   - 独立公式：$$...$$
 *
 * 覆盖：
 *   - 已有 LaTeX（$...$、$$...$$、\(...\)、\[...\]）
 *   - HTML/MathML（<math>）
 *   - Office OMML（Word m:oMath / PowerPoint 中嵌入的 OMML）
 *   - 常见 Unicode 数学符号（×、≤、∑、π 等）
 *
 * 注意：这里只能处理“已经是结构化数学”的内容；图片/扫描 PDF 的公式
 * 仍需要视觉模型识别，纯文本 OCR 只能作为兜底。
 */

const GREEK = {
  'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta',
  'ε': '\\varepsilon', 'ζ': '\\zeta', 'η': '\\eta', 'θ': '\\theta',
  'ι': '\\iota', 'κ': '\\kappa', 'λ': '\\lambda', 'μ': '\\mu',
  'ν': '\\nu', 'ξ': '\\xi', 'π': '\\pi', 'ρ': '\\rho',
  'σ': '\\sigma', 'τ': '\\tau', 'υ': '\\upsilon', 'φ': '\\varphi',
  'χ': '\\chi', 'ψ': '\\psi', 'ω': '\\omega',
  'Γ': '\\Gamma', 'Δ': '\\Delta', 'Θ': '\\Theta', 'Λ': '\\Lambda',
  'Ξ': '\\Xi', 'Π': '\\Pi', 'Σ': '\\Sigma', 'Υ': '\\Upsilon',
  'Φ': '\\Phi', 'Ψ': '\\Psi', 'Ω': '\\Omega',
}

const OPERATORS = {
  '×': '\\times', '÷': '\\div', '±': '\\pm', '∓': '\\mp',
  '≤': '\\le', '≥': '\\ge', '≠': '\\ne', '≈': '\\approx',
  '≡': '\\equiv', '∞': '\\infty', '∑': '\\sum', '∏': '\\prod',
  '∫': '\\int', '∬': '\\iint', '∭': '\\iiint', '∮': '\\oint',
  '√': '\\sqrt', '∂': '\\partial', '∇': '\\nabla',
  '∈': '\\in', '∉': '\\notin', '⊂': '\\subset', '⊆': '\\subseteq',
  '⊃': '\\supset', '⊇': '\\supseteq', '∪': '\\cup', '∩': '\\cap',
  '→': '\\to', '←': '\\leftarrow', '↔': '\\leftrightarrow',
  '⇒': '\\Rightarrow', '⇐': '\\Leftarrow', '⇔': '\\Leftrightarrow',
  '⋅': '\\cdot', '·': '\\cdot', '∘': '\\circ', '′': "'", '″': "''",
  '…': '\\ldots', '⋯': '\\cdots', '°': '^{\\circ}',
}

const MATHML_SKIP = new Set(['annotation', 'annotation-xml', 'semantics'])

function decodeXml(value) {
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

function localName(name) {
  const value = String(name || '')
  const index = value.indexOf(':')
  return index >= 0 ? value.slice(index + 1) : value
}

function attrsOf(source) {
  const attrs = {}
  const regexp = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let match
  while ((match = regexp.exec(String(source || ''))) !== null) attrs[localName(match[1])] = decodeXml(match[2] !== undefined ? match[2] : match[3])
  return attrs
}

/** 极简 XML 树（只用于 MathML/OMML，不处理 DTD/命名空间语义）。 */
export function parseXmlTree(xml) {
  const root = { name: '#root', attrs: {}, children: [] }
  const stack = [root]
  const src = String(xml || '')
  const regexp = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<\/\s*([A-Za-z_][\w:.-]*)\s*>|<([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g
  let last = 0
  let match
  while ((match = regexp.exec(src)) !== null) {
    if (match.index > last) {
      stack[stack.length - 1].children.push({ type: 'text', text: decodeXml(src.slice(last, match.index)) })
    }
    last = regexp.lastIndex
    if (match[1] !== undefined) {
      stack[stack.length - 1].children.push({ type: 'text', text: decodeXml(match[1]) })
      continue
    }
    if (match[2] !== undefined) {
      if (stack.length > 1) stack.pop()
      continue
    }
    if (match[3] !== undefined) {
      const node = { name: localName(match[3]), attrs: attrsOf(match[4] || ''), children: [] }
      stack[stack.length - 1].children.push(node)
      if (match[5] !== '/') stack.push(node)
    }
  }
  return root
}

function children(node) {
  return node && Array.isArray(node.children) ? node.children : []
}

function nodeText(node) {
  if (!node) return ''
  if (node.type === 'text') return node.text || ''
  return children(node).map(nodeText).join('')
}

function child(node, name) {
  return children(node).find((item) => item && item.name === name) || null
}

function childrenNamed(node, name) {
  return children(node).filter((item) => item && item.name === name)
}

function escapeLatex(value) {
  return String(value || '')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([{}_$%&#^~])/g, '\\$1')
}

function mapSymbols(value) {
  return String(value || '').replace(/[α-ωΑ-Ω×÷±∓≤≥≠≈≡∞∑∏∫∬∭∮√∂∇∈∉⊂⊆⊃⊇∪∩→←↔⇒⇐⇔⋅·∘′″…⋯°]/g, (char) => {
    if (GREEK[char]) return GREEK[char] + ' '
    if (OPERATORS[char]) return OPERATORS[char] + ' '
    return char
  })
}

function operator(value) {
  const text = String(value || '').trim()
  if (text === '') return ''
  return OPERATORS[text] || GREEK[text] || escapeLatex(mapSymbols(text))
}

function mathIdentifier(value) {
  const text = String(value || '').trim()
  if (text === '') return ''
  const known = {
    sin: '\\sin', cos: '\\cos', tan: '\\tan', cot: '\\cot', sec: '\\sec', csc: '\\csc',
    log: '\\log', ln: '\\ln', exp: '\\exp', lim: '\\lim', max: '\\max', min: '\\min',
    sup: '\\sup', inf: '\\inf', det: '\\det', gcd: '\\gcd', mod: '\\bmod',
  }
  if (known[text]) return known[text]
  if (/^[A-Za-z]$/.test(text)) return text
  return `\\mathrm{${escapeLatex(text)}}`
}

function mml(node) {
  if (!node || node.type === 'text') return escapeLatex(node ? node.text : '')
  const name = node.name
  if (MATHML_SKIP.has(name)) return ''
  if (name === 'math' || name === 'mrow' || name === 'mstyle' || name === 'mpadded') {
    return children(node).map(mml).join('')
  }
  if (name === 'mi') return mathIdentifier(nodeText(node))
  if (name === 'mn') return escapeLatex(nodeText(node).replace(/\s+/g, ''))
  if (name === 'mo') return operator(nodeText(node))
  if (name === 'mtext') return `\\text{${escapeLatex(nodeText(node))}}`
  if (name === 'msup') {
    const base = children(node)[0]
    const sup = children(node)[1]
    return `${mml(base)}^{${mml(sup)}}`
  }
  if (name === 'msub') {
    const base = children(node)[0]
    const sub = children(node)[1]
    return `${mml(base)}_{${mml(sub)}}`
  }
  if (name === 'msubsup') {
    const base = children(node)[0]
    const sub = children(node)[1]
    const sup = children(node)[2]
    return `${mml(base)}_{${mml(sub)}}^{${mml(sup)}}`
  }
  if (name === 'mfrac') {
    return `\\frac{${mml(children(node)[0])}}{${mml(children(node)[1])}}`
  }
  if (name === 'msqrt') return `\\sqrt{${children(node).map(mml).join('')}}`
  if (name === 'mroot') return `\\sqrt[${mml(children(node)[1])}]{${mml(children(node)[0])}}`
  if (name === 'mfenced') {
    const open = (node.attrs && node.attrs.open) || '('
    const close = (node.attrs && node.attrs.close) || ')'
    return `\\left${open}${children(node).map(mml).join('')}\\right${close}`
  }
  if (name === 'mover' || name === 'munder' || name === 'munderover') {
    const base = mml(children(node)[0])
    const under = name === 'mover' ? null : mml(children(node)[1])
    const over = name === 'mover' ? mml(children(node)[1]) : (name === 'munderover' ? mml(children(node)[2]) : null)
    if (over !== null && over !== '') return `\\overset{${over}}{${base}}`
    if (under !== null && under !== '') return `\\underset{${under}}{${base}}`
    return base
  }
  if (name === 'mspace') return '\\,'
  if (name === 'mtable' || name === 'mtr' || name === 'mtd' || name === 'mlabeledtr') {
    if (name === 'mtr' || name === 'mlabeledtr') return children(node).map(mml).join(' & ')
    if (name === 'mtd') return children(node).map(mml).join('')
    return `\\begin{matrix}${childrenNamed(node, 'mtr').map(mml).join(' \\\\ ')}\\end{matrix}`
  }
  return children(node).map(mml).join('')
}

/** MathML → LaTeX，自动加 $...$ / $$...$$。 */
export function mathmlToLatex(mathml) {
  const tree = parseXmlTree(String(mathml || ''))
  const math = children(tree).find((item) => item && item.name === 'math') || tree
  const latex = children(math).map(mml).join('').trim()
  if (latex === '') return ''
  const display = String(math.attrs && math.attrs.display || '').toLowerCase() === 'block'
  return display ? `$$${latex}$$` : `$${latex}$`
}

function omathChild(node, name) {
  return child(node, name)
}

function omml(node) {
  if (!node || node.type === 'text') return escapeLatex(node ? node.text : '')
  const name = node.name
  if (name.endsWith('Pr') || name === 'ctrlPr') return ''
  if (name === 'oMath' || name === 'oMathPara' || name === 'e' || name === 'num' || name === 'den' ||
      name === 'sub' || name === 'sup' || name === 'deg' || name === 'fName' || name === 'r' ||
      name === 't') {
    if (name === 't') return escapeLatex(nodeText(node))
    if (name === 'r') return childrenNamed(node, 't').map((item) => escapeLatex(nodeText(item))).join('')
    return children(node).map(omml).join('')
  }
  if (name === 'f') {
    return `\\frac{${omml(omathChild(node, 'num'))}}{${omml(omathChild(node, 'den'))}}`
  }
  if (name === 'sSup') {
    const base = children(node).find((item) => item && item.name === 'e')
    return `${omml(base)}^{${omml(omathChild(node, 'sup'))}}`
  }
  if (name === 'sSub') return `${omml(omathChild(node, 'e'))}_{${omml(omathChild(node, 'sub'))}}`
  if (name === 'sSubSup') return `${omml(omathChild(node, 'e'))}_{${omml(omathChild(node, 'sub'))}}^{${omml(omathChild(node, 'sup'))}}`
  if (name === 'rad') {
    const deg = omml(omathChild(node, 'deg'))
    const e = omml(omathChild(node, 'e'))
    return deg === '' ? `\\sqrt{${e}}` : `\\sqrt[${deg}]{${e}}`
  }
  if (name === 'nary') {
    const chr = nodeText(child(child(node, 'naryPr') || {}, 'chr')).trim()
    const op = chr === '∫' ? '\\int' : chr === '∏' ? '\\prod' : '\\sum'
    const sub = omml(omathChild(node, 'sub'))
    const sup = omml(omathChild(node, 'sup'))
    const e = omml(omathChild(node, 'e'))
    return `${op}${sub === '' ? '' : `_{${sub}}`}${sup === '' ? '' : `^{${sup}}`} ${e}`
  }
  if (name === 'd') {
    const pr = child(node, 'dPr') || {}
    const beg = nodeText(child(pr, 'begChr')).trim() || '('
    const end = nodeText(child(pr, 'endChr')).trim() || ')'
    return `\\left${beg}${children(node).filter((item) => item && item.name === 'e').map(omml).join('')}\\right${end}`
  }
  if (name === 'func') {
    return `${omml(omathChild(node, 'fName'))}${omml(omathChild(node, 'e'))}`
  }
  if (name === 'limLow') return `\\underset{${omml(omathChild(node, 'lim'))}}{${omml(omathChild(node, 'e'))}}`
  if (name === 'limUpp') return `\\overset{${omml(omathChild(node, 'lim'))}}{${omml(omathChild(node, 'e'))}}`
  if (name === 'acc') {
    const chr = nodeText(child(child(node, 'accPr') || {}, 'chr')).trim()
    const e = omml(omathChild(node, 'e'))
    const command = chr === '^' ? '\\hat' : chr === '¯' ? '\\bar' : chr === '→' ? '\\vec' : chr === '~' ? '\\tilde' : '\\hat'
    return `${command}{${e}}`
  }
  if (name === 'bar') return `\\overline{${omml(omathChild(node, 'e'))}}`
  if (name === 'eqArr') {
    return `\\begin{aligned}${childrenNamed(node, 'e').map(omml).join(' \\\\ ')}\\end{aligned}`
  }
  if (name === 'm') {
    return `\\begin{matrix}${childrenNamed(node, 'mr').map((row) => childrenNamed(row, 'e').map(omml).join(' & ')).join(' \\\\ ')}\\end{matrix}`
  }
  return children(node).map(omml).join('')
}

/** OMML → LaTeX（用于 Word/PowerPoint 内嵌公式）。 */
export function ommlToLatex(ommlXml) {
  const tree = parseXmlTree(String(ommlXml || ''))
  const math = children(tree).find((item) => item && (item.name === 'oMath' || item.name === 'oMathPara')) || tree
  return children(math).map(omml).join('').trim()
}

function mapMathSymbols(text) {
  return String(text || '').replace(/[α-ωΑ-Ω×÷±∓≤≥≠≈≡∞∑∏∫∬∭∮√∂∇∈∉⊂⊆⊃⊇∪∩→←↔⇒⇐⇔⋅·∘′″…⋯°]/g, (char) => {
    const command = GREEK[char] || OPERATORS[char]
    return command ? command + ' ' : char
  })
}

function convertMathSpan(value) {
  return mapMathSymbols(value)
}

/** 规范化已有 LaTeX；只改数学片段，不碰普通正文和代码块。 */
export function normalizeLatex(input) {
  let text = String(input || '')
  const fences = []
  text = text.replace(/```[\s\S]*?```/g, (block) => {
    fences.push(block)
    return `\u0000FENCE${fences.length - 1}\u0000`
  })
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_m, body) => `$$${convertMathSpan(body)}$$`)
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_m, body) => `$${convertMathSpan(body)}$`)
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_m, body) => `$$${convertMathSpan(body)}$$`)
  text = text.replace(/\$([^$\n]+?)\$/g, (_m, body) => `$${convertMathSpan(body)}$`)
  text = text.replace(/\u0000FENCE(\d+)\u0000/g, (_m, index) => fences[Number(index)] || '')
  return text
}

const FORMULA_HINT = /[∑∏∫∬∭∮√∞≤≥≠≈±×÷πΠΣΔΩαβγδεζηθικλμνξρστυφχψω]/u

function lineIsFormula(line) {
  const trimmed = String(line || '').trim()
  if (trimmed === '' || trimmed.length > 400) return false
  if (/^(#{1,6}\s|[-*+]\s|>\s|```|\||---$)/.test(trimmed)) return false
  if (/\$[^$]+\$/.test(trimmed)) return false
  if (!FORMULA_HINT.test(trimmed)) return false
  const letters = (trimmed.match(/[A-Za-z\u4e00-\u9fff]/g) || []).length
  const mathMarks = (trimmed.match(/[0-9=+\-−*/()∑∏∫√∞≤≥≠≈±×÷πΠΣΔΩαβγδεζηθικλμνξρστυφχψω]/gu) || []).length
  if (mathMarks < 3) return false
  return mathMarks / Math.max(1, letters + mathMarks) >= 0.28
}

function latexifyLine(line) {
  const raw = String(line || '').trim()
  const latex = mapSymbols(raw)
    .replace(/−/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  return latex === '' ? raw : `$$${latex}$$`
}

/** 把“公式密度较高”的普通文本行包成 $$...$$；只用于 PDF/OCR 兜底。 */
export function latexifyFormulaLines(input) {
  return String(input || '')
    .split(/\r?\n/)
    .map((line) => (lineIsFormula(line) ? latexifyLine(line) : line))
    .join('\n')
}

/** 提取疑似公式行（用于在 processed Markdown 里追加“公式”小节）。 */
export function extractFormulaLines(input, limit = 300) {
  const result = []
  const seen = new Set()
  for (const line of String(input || '').split(/\r?\n/)) {
    if (!lineIsFormula(line)) continue
    const latex = latexifyLine(line)
    if (latex === '' || seen.has(latex)) continue
    seen.add(latex)
    result.push(latex)
    if (result.length >= limit) break
  }
  return result
}

