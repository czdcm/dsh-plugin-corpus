/**
 * dsh-plugin-corpus v1.3 — 文档提取层验收测试（新）。
 *
 * 自包含：只在 os.tmpdir() 下造合成文件，跑完（含失败）清理；
 * 不依赖本机安装的 Python / officecli / pdftotext —— 测试内用 Node 内置 zlib
 * 手工构造最小 OOXML ZIP（docx/xlsx/pptx）与带文字层的合法 PDF（含 Font/Resources）。
 *
 * 覆盖：
 *   · zip.js       —— 自造 ZIP 的中央目录/本地头读取，坏输入拒绝；
 *   · office.js    —— docx（标题/段落/表格）、xlsx（sharedStrings/内联字符串/数字）、
 *                     pptx（presentation rels + 多页顺序）纯 JS 抽文本；
 *   · extract.js   —— 文本/CSV/HTML（标题、实体解码、script/style/noscript/注释剔除）、
 *                     图片返回 kind:'image' + mediaType、maxBytes/不存在/目录/扩展名拒绝、
 *                     空文本 warning、extractorAvailability 与 SUPPORTED_EXTENSIONS；
 *   · pdf.js       —— 纯 JS 文字层提取；随包 vendor/pdftotext 可用时再验一条（没有则 SKIP 注明）。
 *
 * 运行（DSH 自带 Node 24）：
 *   & "…\dependencies\node\bin\node.exe" tests\test-extract.mjs
 * 输出：PASS/SKIP 行 + 末尾「全部通过: N 项」；失败抛错、退出码非 0。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { SUPPORTED_EXTENSIONS, bundledOfficecli, extractDocument, extractorAvailability, htmlToText } from '../plugin/lib/extract.js'
import { extractOffice, extractXlsxFormulas } from '../plugin/lib/office.js'
import { extractPdfText, ocrAvailable, pdfExtractorAvailability } from '../plugin/lib/pdf.js'
import { readZip } from '../plugin/lib/zip.js'

let pass = 0
let skip = 0
const ok = (label) => { pass++; console.log('  PASS ' + label) }
const skipTest = (label, reason) => { skip++; console.log('  SKIP ' + label + '（' + reason + '）') }
const assert = (condition, message) => { if (!condition) throw new Error('ASSERT: ' + message) }

async function expectRejects(value, label, needle) {
  let error = null
  try { await value } catch (caught) { error = caught }
  if (error === null) throw new Error('应当被拒绝却成功了：' + label)
  if (needle && !String(error && error.message).includes(needle)) {
    throw new Error(`拒绝原因不符（${label}）：期望包含「${needle}」，实际「${error && error.message}」`)
  }
  return error
}

// ---------------------------------------------------------------------------
// 最小 ZIP 写入器（只依赖 node:zlib，用来构造 docx/xlsx/pptx 夹具）
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let value = 0; value < 256; value++) {
    let current = value
    for (let bit = 0; bit < 8; bit++) current = (current & 1) ? (0xedb88320 ^ (current >>> 1)) : (current >>> 1)
    table[value] = current
  }
  return table
})()

function crc32(buffer) {
  let value = -1
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ -1) >>> 0
}

const u16 = (value) => { const buffer = Buffer.alloc(2); buffer.writeUInt16LE(value); return buffer }
const u32 = (value) => { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value); return buffer }

/** @param entries {{name:string, data:string|Buffer}[]} @returns {Buffer} 合法 ZIP（deflate）。 */
function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8')
    const compressed = zlib.deflateRawSync(raw)
    const checksum = crc32(raw)
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0),
      u32(checksum), u32(compressed.length), u32(raw.length), u16(name.length), u16(0), name, compressed,
    ])
    locals.push(local)
    centrals.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0),
      u32(checksum), u32(compressed.length), u32(raw.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), name,
    ]))
    offset += local.length
  }
  const central = Buffer.concat(centrals)
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(central.length), u32(offset), u16(0),
  ])
  return Buffer.concat([...locals, central, eocd])
}

// ---------------------------------------------------------------------------
// 最小文字层 PDF 写入器（合法 xref；/Contents 未压缩，pdftotext 与纯 JS 都能读）
// ---------------------------------------------------------------------------
function buildTextPdf() {
  const content = Buffer.from(
    'BT\n/F1 18 Tf\n72 720 Td\n(Corpus PDF Test) Tj\n0 -28 Td\n(Second line of PDF text.) Tj\nET\n',
    'latin1',
  )
  const parts = []
  const offsets = []
  let position = 0
  const push = (buffer) => { parts.push(buffer); position += buffer.length }
  push(Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1'))
  const addObject = (number, body) => {
    offsets[number] = position
    push(Buffer.from(`${number} 0 obj\n`, 'latin1'))
    push(body)
    push(Buffer.from('\nendobj\n', 'latin1'))
  }
  addObject(1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'))
  addObject(2, Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1'))
  addObject(3, Buffer.from(
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
    + '/Resources << /Font << /F1 4 0 R >> /ProcSet [/PDF /Text] >> /Contents 5 0 R >>',
    'latin1',
  ))
  addObject(4, Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', 'latin1'))
  addObject(5, Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'latin1'), content, Buffer.from('endstream', 'latin1')]))
  const xrefOffset = position
  const xrefLines = ['xref', '0 6', '0000000000 65535 f ']
  for (let number = 1; number <= 5; number++) xrefLines.push(String(offsets[number]).padStart(10, '0') + ' 00000 n ')
  push(Buffer.from(xrefLines.join('\n') + '\n', 'latin1'))
  push(Buffer.from(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1'))
  return Buffer.concat(parts)
}

// ---------------------------------------------------------------------------
// 临时目录 + 夹具
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-extract-'))
const write = (name, data) => {
  const file = path.join(tmp, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, data)
  return file
}

try {
  // -------------------------------------------------------------------------
  // 1. zip.js：自造 ZIP 可被读回
  // -------------------------------------------------------------------------
  const zipFixture = makeZip([
    { name: 'word/hello.txt', data: 'hello zip' },
    { name: 'dir/nested.xml', data: '<a>z</a>' },
  ])
  const zipEntries = readZip(zipFixture)
  assert(zipEntries instanceof Map && zipEntries.size === 2, 'readZip 应读回 2 个条目')
  assert(zipEntries.get('word/hello.txt').toString('utf8') === 'hello zip', 'ZIP 文本条目内容')
  assert(zipEntries.get('dir/nested.xml').toString('utf8') === '<a>z</a>', 'ZIP 嵌套条目内容')
  await expectRejects(Promise.resolve().then(() => readZip(Buffer.from('definitely not a zip'))), 'readZip 坏输入', '不是有效的 ZIP')
  ok('zip.js：自造 ZIP 读回（store/deflate）+ 坏输入拒绝')

  // -------------------------------------------------------------------------
  // 2. office.js：纯 JS docx / xlsx / pptx
  // -------------------------------------------------------------------------
  const a = (name, data) => ({ name, data })

  const docxBuffer = makeZip([
    a('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    a('docProps/core.xml', '<?xml version="1.0"?><cp:coreProperties xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Synthetic DOCX</dc:title></cp:coreProperties>'),
    a('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Corpus DOCX Title</w:t></w:r></w:p>
        <w:p><w:r><w:t xml:space="preserve">Hello from docx &amp; friends.</w:t></w:r></w:p>
        <w:p><m:oMath><m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f></m:oMath></w:p>
        <w:tbl>
          <w:tr><w:tc><w:p><w:r><w:t>Key</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr>
          <w:tr><w:tc><w:p><w:r><w:t>alpha</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc></w:tr>
        </w:tbl>
      </w:body></w:document>`),
  ])
  const docx = extractOffice(docxBuffer, '.docx')
  assert(docx.format === 'docx' && docx.title === 'Synthetic DOCX', 'docx 标题应优先取 docProps/core.xml，实际 ' + JSON.stringify(docx.title))
  assert(docx.text.includes('# Corpus DOCX Title'), 'docx 标题段应转成 Markdown 标题')
  assert(docx.text.includes('Hello from docx & friends.'), 'docx 正文段落 + 实体解码')
  assert(docx.text.includes('Key | Value') && docx.text.includes('alpha | 1'), 'docx 表格单元格应以 " | " 连接')
  assert(docx.text.includes('\\frac{1}{2}'), 'docx OMML 公式应保留为 LaTeX，实际：' + JSON.stringify(docx.text.slice(0, 200)))
  assert(docx.meta && typeof docx.meta.paragraphs === 'number' && docx.meta.paragraphs >= 3, 'docx meta.paragraphs')
  ok('office.js docx：标题（core.xml）+ 标题段 + 段落 + 表格 + OMML 公式')

  const xlsxBuffer = makeZip([
    a('docProps/core.xml', '<?xml version="1.0"?><cp:coreProperties xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Synthetic XLSX</dc:title></cp:coreProperties>'),
    a('xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    a('xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    a('xl/sharedStrings.xml', '<?xml version="1.0"?><sst><si><t>Name</t></si><si><t>Alice</t></si><si><t>Score</t></si></sst>'),
    a('xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c></row>
      <row r="3"><c r="A3" t="inlineStr"><is><t>Inline</t></is></c><c r="B3"><v>7</v></c><c r="C3"><f>SUM(B2:B3)</f><v>49</v></c></row>
    </sheetData></worksheet>`),
  ])
  const xlsx = extractOffice(xlsxBuffer, '.xlsx')
  assert(xlsx.format === 'xlsx' && xlsx.title === 'Synthetic XLSX', 'xlsx 标题应优先取 core.xml')
  assert(xlsx.text.includes('## Sheet: Data'), 'xlsx 应有工作表小标题，实际：' + JSON.stringify(xlsx.text.slice(0, 80)))
  assert(xlsx.text.includes('Name | Alice') && xlsx.text.includes('Score | 42'), 'xlsx sharedStrings + 数字单元格')
  assert(xlsx.text.includes('Inline | 7'), 'xlsx 内联字符串单元格')
  assert(xlsx.meta && Array.isArray(xlsx.meta.sheets) && xlsx.meta.sheets.join(',') === 'Data', 'xlsx meta.sheets')
  const xlsxFormulas = extractXlsxFormulas(xlsxBuffer)
  assert(xlsxFormulas.includes('Data!C3: =SUM(B2:B3)'), 'xlsx 公式抽取：' + JSON.stringify(xlsxFormulas))
  ok('office.js xlsx：workbook rels + sharedStrings + 数字 / inlineStr 单元格 + 公式')

  const pptxBuffer = makeZip([
    a('ppt/presentation.xml', '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>'),
    a('ppt/_rels/presentation.xml.rels', '<?xml version="1.0"?><Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>'),
    a('ppt/slides/slide1.xml', '<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Corpus PPTX Slide One</a:t></a:r></a:p><a:p><a:r><a:t>bullet one &amp; two</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'),
    a('ppt/slides/slide2.xml', '<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Second slide body</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'),
  ])
  const pptx = extractOffice(pptxBuffer, '.pptx')
  assert(pptx.format === 'pptx' && pptx.title === 'Corpus PPTX Slide One', 'pptx 标题应回退到第一页文本，实际 ' + JSON.stringify(pptx.title))
  assert(pptx.text.includes('## Slide 1') && pptx.text.includes('## Slide 2'), 'pptx 应按 presentation rels 顺序输出页标题')
  assert(pptx.text.includes('bullet one & two') && pptx.text.includes('Second slide body'), 'pptx 幻灯片文本 + 实体解码')
  assert(pptx.meta && pptx.meta.slides === 2, 'pptx meta.slides 应为 2')
  ok('office.js pptx：presentation rels + 多页顺序 + 实体解码')

  let badOffice = null
  try { extractOffice(docxBuffer, '.doc') } catch (error) { badOffice = error }
  assert(badOffice && String(badOffice.message).includes('不支持的 Office 格式'), 'extractOffice 应拒绝非 v1.3 Office 格式')
  ok('office.js：不支持的 Office 扩展名被拒绝')

  // 把 OOXML 夹具落盘，走完整 extractDocument 路径。
  // v1.3 宿主会优先试随包 vendor/officecli（成功则 extractor='officecli'），
  // 最小 OOXML 上它通常输出为空 → 回退 office.js（extractor='office-js'）；两种都接受。
  const docxFile = write('synthetic.docx', docxBuffer)
  const xlsxFile = write('synthetic.xlsx', xlsxBuffer)
  const pptxFile = write('synthetic.pptx', pptxBuffer)
  const docxDoc = await extractDocument(docxFile)
  const xlsxDoc = await extractDocument(xlsxFile)
  const pptxDoc = await extractDocument(pptxFile)
  const officeExtractors = ['officecli', 'office-js']
  assert(docxDoc.kind === 'text' && docxDoc.format === 'docx' && officeExtractors.includes(docxDoc.meta.extractor), 'extractDocument docx extractor 应为 officecli 或 office-js，实际 ' + docxDoc.meta.extractor)
  assert(docxDoc.text.includes('Corpus DOCX Title') && docxDoc.text.includes('Hello from docx'), 'extractDocument docx 内容')
  assert(typeof docxDoc.title === 'string' && docxDoc.title !== '', 'extractDocument docx 应有标题')
  assert(xlsxDoc.text.includes('Alice') && xlsxDoc.text.includes('42') && xlsxDoc.format === 'xlsx', 'extractDocument xlsx 内容')
  assert(pptxDoc.text.includes('Corpus PPTX Slide One') && pptxDoc.format === 'pptx', 'extractDocument pptx 内容')
  ok('extractDocument：docx/xlsx/pptx 提取（随包 officecli 优先，不可用/为空时回退纯 JS office.js）')

  // -------------------------------------------------------------------------
  // 3. 文本 / CSV / HTML
  // -------------------------------------------------------------------------
  const mdFile = write('notes.md', '# Notes Title\n\nbody text with corpus keyword\n')
  const mdDoc = await extractDocument(mdFile)
  assert(mdDoc.ok === true && mdDoc.kind === 'text' && mdDoc.format === 'md', 'markdown 基本字段')
  assert(mdDoc.title === 'Notes Title', 'markdown 标题取 # 标题行，实际 ' + JSON.stringify(mdDoc.title))
  assert(mdDoc.text.includes('body text with corpus keyword') && mdDoc.meta.extractor === 'text', 'markdown 正文 + extractor=text')
  const txtFile = write('plain.txt', 'plain first line as title\nsecond line\n')
  const txtDoc = await extractDocument(txtFile)
  assert(txtDoc.title === 'plain first line as title' && txtDoc.format === 'txt', 'txt 标题回退到首个非空行')
  const csvFile = write('table.csv', 'name,score\nalice,42\n')
  const csvDoc = await extractDocument(csvFile)
  assert(csvDoc.format === 'csv' && csvDoc.text.includes('alice,42') && csvDoc.meta.extractor === 'text', 'csv 按文本读取')
  ok('文本类：md 标题 / txt 首行标题 / csv 原样文本')

  const html = `<!doctype html><html><head>
<title>Doc &amp; Title</title>
<style>.secret { color: red; }</style>
<script>var secret = "script must not appear"</script>
<noscript>noscript must not appear</noscript>
</head><body>
<!-- comment must not appear -->
<h1>Hello &amp; World</h1>
<h2>Sub &amp; Section</h2>
<p>Tom &amp; Jerry &lt;tag&gt; &#65; &#x42;&nbsp;end</p>
<ul><li>item one</li><li>item two</li></ul>
<table><tr><td>Cell A</td><td>Cell B</td></tr></table>
</body></html>`
  const converted = htmlToText(html)
  assert(converted.title === 'Doc & Title', 'htmlToText 应解码 <title> 实体，实际 ' + JSON.stringify(converted.title))
  assert(converted.text.includes('# Hello & World'), 'HTML h1 → Markdown #')
  assert(converted.text.includes('## Sub & Section'), 'HTML h2 → Markdown ## + 实体解码')
  assert(converted.text.includes('Tom & Jerry <tag> A B end'), 'HTML 数值/命名实体应解码')
  assert(converted.text.includes('- item one') && converted.text.includes('- item two'), 'HTML li → "- " 列表')
  assert(converted.text.includes('Cell A') && converted.text.includes('Cell B'), 'HTML 表格单元格文本保留')
  for (const hidden of ['script must not appear', 'noscript must not appear', 'comment must not appear', '.secret', '<script']) {
    assert(!converted.text.includes(hidden), 'HTML 应剔除 script/style/noscript/注释，泄漏了：' + hidden)
  }
  const htmlFile = write('page.html', html)
  const htmlDoc = await extractDocument(htmlFile)
  assert(htmlDoc.format === 'html' && htmlDoc.title === 'Doc & Title' && htmlDoc.meta.extractor === 'html', 'extractDocument html 标题/format/extractor')
  assert(htmlDoc.text.includes('# Hello & World') && !htmlDoc.text.includes('script must not appear'), 'extractDocument html 转换结果')
  ok('HTML → 文本：标题 / 标题层级 / 列表 / 表格 / 实体解码 / script·style·noscript·注释剔除')

  // -------------------------------------------------------------------------
  // 4. 图片：只返回 kind + mediaType，不要求 OCR
  // -------------------------------------------------------------------------
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const pngFile = write('pixel.png', pngBytes)
  const pngDoc = await extractDocument(pngFile)
  assert(pngDoc.ok === true && pngDoc.kind === 'image' && pngDoc.mediaType === 'image/png', 'png → kind:image + image/png')
  assert(pngDoc.title === 'pixel' && pngDoc.text === '' && pngDoc.format === 'png', 'png 标题回退文件名、文本为空')
  const jpgFile = write('photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]))
  const jpegFile = write('photo2.jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x45, 0x78, 0x69, 0x66]))
  const webpFile = write('image.webp', Buffer.from('RIFF\x1a\x00\x00\x00WEBPVP8 \x0e\x00\x00\x00', 'latin1'))
  const jpgDoc = await extractDocument(jpgFile)
  const jpegDoc = await extractDocument(jpegFile)
  const webpDoc = await extractDocument(webpFile)
  assert(jpgDoc.kind === 'image' && jpgDoc.mediaType === 'image/jpeg', 'jpg → image/jpeg')
  assert(jpegDoc.kind === 'image' && jpegDoc.mediaType === 'image/jpeg' && jpegDoc.format === 'jpeg', 'jpeg → image/jpeg')
  assert(webpDoc.kind === 'image' && webpDoc.mediaType === 'image/webp', 'webp → image/webp')
  // v1.3 扩展图片格式：gif / bmp / tif / tiff（只验 kind+mediaType，不要求真能解码）
  const gifFile = write('anim.gif', Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;', 'latin1'))
  const bmpFile = write('bitmap.bmp', Buffer.from('BM\x3a\x00\x00\x00\x00\x00\x00\x00\x36\x00\x00\x00(\x00\x00\x00\x01\x00\x00\x00\x01\x00\x00\x00\x01\x00\x18\x00', 'latin1'))
  const tifFile = write('scan.tif', Buffer.from('II*\x00\x08\x00\x00\x00\x00\x00', 'latin1'))
  const tiffFile = write('scan2.tiff', Buffer.from('MM\x00*\x00\x00\x00\x08\x00\x00', 'latin1'))
  const gifDoc = await extractDocument(gifFile)
  const bmpDoc = await extractDocument(bmpFile)
  const tifDoc = await extractDocument(tifFile)
  const tiffDoc = await extractDocument(tiffFile)
  assert(gifDoc.kind === 'image' && gifDoc.mediaType === 'image/gif', 'gif → image/gif')
  assert(bmpDoc.kind === 'image' && bmpDoc.mediaType === 'image/bmp', 'bmp → image/bmp')
  assert(tifDoc.kind === 'image' && tifDoc.mediaType === 'image/tiff' && tifDoc.format === 'tif', 'tif → image/tiff')
  assert(tiffDoc.kind === 'image' && tiffDoc.mediaType === 'image/tiff' && tiffDoc.format === 'tiff', 'tiff → image/tiff')
  ok('图片：png/jpg/jpeg/webp/gif/bmp/tif/tiff 返回 kind:image 与 mediaType（不要求 OCR）')

  // -------------------------------------------------------------------------
  // 5. PDF：纯 JS 兜底 + 随包 pdftotext（可选）
  // -------------------------------------------------------------------------
  const pdfFile = write('text-layer.pdf', buildTextPdf())
  const pdfBuffer = fs.readFileSync(pdfFile)
  const jsText = extractPdfText(pdfBuffer)
  assert(jsText.includes('Corpus PDF Test'), '纯 JS 应抽出文字层第一行，实际：' + JSON.stringify(jsText))
  assert(jsText.includes('Second line of PDF text.'), '纯 JS 应抽出文字层第二行')
  const pdfDoc = await extractDocument(pdfFile)
  assert(pdfDoc.kind === 'text' && pdfDoc.format === 'pdf', 'PDF → kind:text / format:pdf')
  assert(pdfDoc.text.includes('Corpus PDF Test') && pdfDoc.text.includes('Second line of PDF text.'), 'extractDocument PDF 文本，extractor=' + pdfDoc.meta.extractor)
  assert(pdfDoc.title === 'Corpus PDF Test', 'PDF 标题回退首行，实际 ' + JSON.stringify(pdfDoc.title))
  const pdfAvail = pdfExtractorAvailability()
  if (pdfAvail.bundled) {
    assert(pdfDoc.meta.extractor === 'bundled-pdftotext', '有随包 pdftotext 时应优先用它，实际 ' + pdfDoc.meta.extractor)
    ok('PDF：随包 vendor/pdftotext 直接提取文字层（纯 JS 兜底也已单独验证）')
  } else {
    assert(pdfDoc.meta.extractor === 'pdf-js', '没有 vendor 时应走纯 JS 提取，实际 ' + pdfDoc.meta.extractor)
    skipTest('PDF：随包 pdftotext', 'vendor/pdftotext 不存在（非 Windows x64 部署），已用纯 JS 兜底验证')
  }

  // 可选 OCR 冒烟：默认跳过（PowerShell + Windows OCR 要几秒，且识别结果依赖引擎）
  if (process.env.CORPUS_TEST_OCR === '1' && ocrAvailable()) {
    const { runWindowsOcr } = await import('../plugin/lib/pdf.js')
    try {
      const ocrText = await runWindowsOcr(pngFile, 'image')
      assert(typeof ocrText === 'string', 'OCR 应返回字符串')
      ok('Windows OCR 冒烟（CORPUS_TEST_OCR=1）：1x1 PNG 返回字符串（内容可为空）')
    } catch (error) {
      ok('Windows OCR 冒烟（CORPUS_TEST_OCR=1）：明确抛错而非静默（' + String(error && error.message).slice(0, 40) + '…）')
    }
  } else {
    skipTest('Windows OCR 冒烟', '默认关闭；设置 CORPUS_TEST_OCR=1 且 ocrAvailable() 时运行')
  }

  // -------------------------------------------------------------------------
  // 6. extractorAvailability / SUPPORTED_EXTENSIONS
  // -------------------------------------------------------------------------
  const availability = extractorAvailability()
  assert(Object.keys(availability).sort().join(',') === 'bundle,html,image,ocr,office,officecli,pdf', 'extractorAvailability 字段应为 {pdf,office,officecli,html,bundle,ocr,image}，实际 ' + Object.keys(availability).join(','))
  assert(availability.pdf === true && availability.office === true && availability.html === true && availability.image === true, '纯 JS 提取器（pdf/office/html/image）应始终可用')
  assert(typeof availability.bundle === 'boolean' && typeof availability.ocr === 'boolean' && typeof availability.officecli === 'boolean', 'bundle/ocr/officecli 应是布尔值')
  assert(availability.officecli === (bundledOfficecli() !== null), 'officecli 可用性应与 bundledOfficecli() 一致')
  ok('extractorAvailability：{pdf,office,officecli,html,bundle,ocr,image} 形状 + bundledOfficecli() 一致')
  if (bundledOfficecli() !== null) {
    ok('随包 officecli：vendor/officecli/officecli.exe 存在（Office 优先用它，失败回退纯 JS）')
  } else {
    skipTest('随包 officecli', 'vendor/officecli 不存在（非 Windows x64），Office 走纯 JS 回退')
  }

  const expectedExts = ['.md', '.markdown', '.txt', '.text', '.html', '.htm', '.csv', '.pdf', '.docx', '.xlsx', '.pptx', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff']
  assert(SUPPORTED_EXTENSIONS.join(',') === expectedExts.join(','), 'SUPPORTED_EXTENSIONS 与契约 v1.3 不一致：' + SUPPORTED_EXTENSIONS.join(','))
  ok('SUPPORTED_EXTENSIONS：19 种格式与契约一致（含 gif/bmp/tif/tiff）')

  // -------------------------------------------------------------------------
  // 7. 拒绝路径 / 边界
  // -------------------------------------------------------------------------
  await expectRejects(extractDocument(path.join(tmp, 'missing.md')), '不存在的文件', '找不到文件')
  await expectRejects(extractDocument(tmp), '目录不是文件', '不是文件')
  const unsupported = write('payload.bin', Buffer.from([0x00, 0x01, 0x02]))
  await expectRejects(extractDocument(unsupported), '不支持的扩展名', '不支持的格式')
  await expectRejects(extractDocument(mdFile, { maxBytes: 2 }), 'maxBytes 上限', '文件超过上限')
  const emptyFile = write('empty.md', '   \n\n')
  const emptyDoc = await extractDocument(emptyFile)
  assert(emptyDoc.text.trim() === '' && emptyDoc.warnings.some((item) => item.includes('提取结果为空')), '空文本应带「提取结果为空」warning')
  const hugeName = write('big.md', '# Big\n\n' + 'x'.repeat(9000))
  const hugeDoc = await extractDocument(hugeName)
  assert(hugeDoc.text.length > 9000 && !hugeDoc.warnings.some((item) => item.includes('已截断')), '未超 8 MiB 不应截断')
  ok('边界：不存在/目录/不支持的扩展名/maxBytes 拒绝 + 空文本 warning')

  console.log('\n全部通过: ' + pass + ' 项' + (skip > 0 ? '（跳过 ' + skip + ' 项）' : ''))
} finally {
  // Windows 上临时目录偶尔被 Defender/索引占用，rmSync 支持 EPERM 重试。
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 })
}
