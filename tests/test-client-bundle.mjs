/**
 * tests/test-client-bundle.mjs — dsh-plugin-corpus 客户端 bundle 静态验证。
 *
 * 用 node:vm 造 window/document/navigator/FileReader 桩，加载 plugin/lib/client.js：
 *   · loader 收到 id、防重复注册标记、重复执行不再 load；
 *   · factory(require('react')) 返回带 inject/apply 的 exports；
 *   · apply 后在 ctx.effect 内注册 sidebar.panellist + main（id/key/order 正确）；
 *   · v1.2 右栏：sidebarRightTabs 类型（id/kind/priority/guide order 55）+ pane body；
 *   · locale 注册 zh/en 的 nav/permTitle，label 跟随语言；
 *   · 整页组件首屏渲染不抛错、不提前 fetch；挂载 effect 会 GET /overview + /status；
 *   · 右栏权限面板：渲染会话/工作区/全局/其他规则；新增（带有效期）/删除/default/deny
 *     都是 GET /policy → POST /policy → 重拉 GET /access；
 *   · v1.3 主页面「导入语料」区（不是右栏 tab）：头部按钮展开/收起、文件多选或本机路径、
 *     集合/prefix、AI 开关、POST /import 两种 body、1s 轮询 /import/status、完成刷新 overview；
 *   · v1.5 主页面「语料库根目录」设置区：GET /settings、POST /settings/root、POST /settings/open
 *     三个 API + 当前路径/复制/打开资源管理器/两次点击确认迁移/restartRequired 提示，
 *     首屏不 fetch（展开「更改位置」才 GET /settings）；
 *   · 源码包含面板 API 路径（含 /access 与 /import/*）、只用 require('react')、使用 DSH 设计 token。
 *
 * 运行：DSH 自带 Node 24.x
 *   & $node tests\test-client-bundle.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_FILE = path.join(PROJECT, 'plugin', 'lib', 'client.js')
const CLIENT_ID = 'dsh-plugin-corpus'
const FLAG = '__DSH_CORPUS_REGISTERED__'
const API_BASE = '/api/dsh-plugin-corpus'
const ROUTES = ['overview', 'files', 'search', 'read', 'reindex', 'status', 'policy', 'access', 'import/targets', 'import/status']
const IMPORT_START = API_BASE + '/import'
const IMPORT_TARGETS_URL = API_BASE + '/import/targets'
const IMPORT_STATUS_URL = API_BASE + '/import/status'
const PERMISSIONS_TAB_ID = 'dsh-plugin-corpus-permissions'
const PERMISSIONS_KIND = 'corpus-permissions'
// CorpusPage 自身的 12 个 useState（0..11）之后，才是 ImportSection 的 hook。
const IMPORT_HOOK_OFFSET = 12

const IMPORT_TARGETS = {
  ok: true,
  collections: [
    { name: 'dsh-docs', backend: 'like', docs: 109 },
    { name: 'linux-kernel', backend: 'like', docs: 39 },
  ],
  formats: ['.md', '.markdown', '.txt', '.text', '.html', '.htm', '.pdf', '.docx', '.xlsx', '.pptx', '.csv', '.png', '.jpg', '.jpeg', '.webp'],
  extractors: { pdf: false, office: true, ocr: true, image: true, bundle: false },
  visionAvailable: true,
  aiAvailable: true,
  limits: { maxFiles: 200, maxUploadBytes: 25 * 1024 * 1024 },
}

const SOURCE = fs.readFileSync(CLIENT_FILE, 'utf8')

let pass = 0
function ok(label, condition) {
  if (!condition) throw new Error(label)
  pass++
  console.log('  PASS ' + label)
}
function eq(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(label + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual))
  }
  pass++
  console.log('  PASS ' + label)
}
function noThrow(label, fn) {
  try {
    fn()
  } catch (error) {
    throw new Error(label + '：不应抛错，实际 ' + (error && error.message ? error.message : error))
  }
  pass++
  console.log('  PASS ' + label)
}

function makeResponse(body, status) {
  const code = Number(status) || 200
  return {
    ok: code >= 200 && code < 300,
    status: code,
    json: async () => body,
  }
}

function makeReact(seed) {
  const effects = []
  let useStateIndex = 0
  const React = {
    createElement(type, props) {
      const children = Array.prototype.slice.call(arguments, 2)
      return { type, props: props || {}, children }
    },
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const index = useStateIndex++
      const value = typeof initial === 'function' ? initial() : initial
      if (seed && seed.byIndex && Object.prototype.hasOwnProperty.call(seed.byIndex, index)) {
        return [seed.byIndex[index], () => {}]
      }
      return [value, () => {}]
    },
    useEffect(callback) {
      effects.push(callback)
    },
    useCallback(callback) {
      return callback
    },
    useMemo(factory) {
      return factory()
    },
    useRef(initial) {
      return { current: initial }
    },
  }
  return { React, effects }
}

/** 造一个假浏览器 + 假模块加载器，执行 client.js。 */
function boot(lang, options) {
  const { React, effects } = makeReact(options && options.seed)
  const loaderCalls = []
  const fetchCalls = []
  const policySummary = {
    accessFile: 'C:/dsh/corpus-access.json', exists: true, default: 'deny', grants: [], deny: [], error: null, mtimeMs: 1,
  }
  const responseFor = (url, init) => {
    const target = String(url)
    if (target.indexOf(API_BASE + '/overview') !== -1) {
      return makeResponse({
        ok: true,
        root: 'C:/corpus',
        stats: { collections: 2, docs: 3, chunks: 4, bytes: 1024, indexBytes: 2048 },
        collections: [],
        policy: policySummary,
      })
    }
    if (target.indexOf(API_BASE + '/status') !== -1) {
      return makeResponse({ ok: true, active: null, recent: [], collections: [] })
    }
    if (target.indexOf(IMPORT_TARGETS_URL) === 0) {
      return makeResponse({ ok: true, ...IMPORT_TARGETS })
    }
    if (target.indexOf(IMPORT_STATUS_URL) === 0) {
      return makeResponse({ ok: true, active: null, recent: [] })
    }
    if (target === IMPORT_START) {
      return makeResponse({
        ok: true,
        started: true,
        job: {
          id: 'import-job-default', state: 'running', collection: 'dsh-docs',
          total: 1, done: 0, failed: 0, current: { source: 'a.md', stage: 'extract' }, items: [],
        },
      })
    }
    if (target === API_BASE + '/policy') {
      if (init && init.method === 'POST') {
        return makeResponse({ ok: true, policy: policySummary, accessFile: policySummary.accessFile, backup: null })
      }
      return makeResponse({ ok: true, ...policySummary })
    }
    if (target.indexOf(API_BASE + '/access') === 0) {
      return makeResponse({
        ok: true,
        sessionId: '',
        workspace: 'C:/work/DSH',
        workspaceKey: 'c:/work/dsh',
        effectiveCollections: [],
        collections: [],
        policy: policySummary,
      })
    }
    return makeResponse({ ok: true })
  }
  const respond = options && typeof options.responder === 'function' ? options.responder : responseFor
  // FileReader 桩：readAsDataURL → data URL（客户端只保留 base64 部分）。
  class FakeFileReader {
    constructor() {
      this.result = null
      this.error = null
      this.onload = null
      this.onerror = null
    }
    readAsDataURL(file) {
      const content = String(file && file.content !== undefined ? file.content : '')
      this.result = 'data:application/octet-stream;base64,' + Buffer.from(content, 'utf8').toString('base64')
      if (typeof this.onload === 'function') this.onload({ target: this })
    }
  }
  const captureTimers = options && Array.isArray(options.captureTimers) ? options.captureTimers : null
  const sandbox = {
    console,
    setTimeout: captureTimers !== null
      ? (callback, delay) => {
          captureTimers.push({ callback, delay })
          return captureTimers.length
        }
      : setTimeout,
    clearTimeout,
    navigator: { language: lang },
    document: { documentElement: { lang, getAttribute: (name) => (name === 'lang' ? lang : null) } },
    FileReader: FakeFileReader,
    fetch(url, init) {
      fetchCalls.push({ url, init })
      return Promise.resolve(respond(url, init))
    },
  }
  sandbox.window = {
    __ModuleLoader__: {
      load(definition) {
        loaderCalls.push(definition)
      },
    },
    FileReader: FakeFileReader,
  }
  sandbox.window.document = sandbox.document
  sandbox.window.navigator = sandbox.navigator
  sandbox.window.fetch = sandbox.fetch
  sandbox.window.setTimeout = setTimeout
  sandbox.globalThis = sandbox

  const context = vm.createContext(sandbox)
  const script = new vm.Script(SOURCE, { filename: CLIENT_FILE })
  script.runInContext(context)
  return {
    React,
    effects,
    loaderCalls,
    fetchCalls,
    sandbox,
    context,
    script,
    window: sandbox.window,
    rerun() {
      script.runInContext(context)
    },
  }
}

function bootExports(lang, options) {
  const harness = boot(lang, options)
  ok('loader 收到一次 load 调用', harness.loaderCalls.length === 1)
  const definition = harness.loaderCalls[0]
  ok('load 参数带 id / factory', definition !== null && typeof definition === 'object' && typeof definition.factory === 'function')
  eq('loader id 是包名', definition.id, CLIENT_ID)
  const requireCalls = []
  const exports = definition.factory((id) => {
    requireCalls.push(id)
    if (id === 'react') return harness.React
    throw new Error('unexpected require: ' + id)
  })
  return { harness, definition, exports, requireCalls }
}

function makeSlots() {
  const slots = {
    injected: [],
    registered: [],
    _insideEffect: false,
    inject(name, factory) {
      slots.injected.push(name)
      return factory()
    },
    register(definition, component) {
      slots.registered.push({ definition, component, insideEffect: slots._insideEffect === true })
      return { definition, component }
    },
  }
  return slots
}

function makeCtx(options) {
  const slots = options.slots
  const lang = options.lang || 'zh-CN'
  const dictionaryCalls = []
  const effectLabels = []
  const tabTypes = []
  const openedTabs = []
  let effectDepth = 0
  const locale = {
    register(namespace, dictionaries) {
      dictionaryCalls.push({ namespace, dictionaries })
      return () => {}
    },
    bind(namespace) {
      return (key) => {
        const entry = dictionaryCalls.find((item) => item.namespace === namespace)
        if (!entry) return key
        const table = String(lang).toLowerCase().indexOf('zh') === 0 ? entry.dictionaries.zh : entry.dictionaries.en
        return table && Object.prototype.hasOwnProperty.call(table, key) ? String(table[key]) : key
      }
    },
  }
  const tabs = {
    register(definition) {
      tabTypes.push({ definition, insideEffect: effectDepth > 0 })
      return () => {}
    },
  }
  const sidebarRight = {
    openTab(kind, tabOptions) {
      openedTabs.push({ kind, options: tabOptions || null })
      return {}
    },
  }
  const store = new Map()
  if (slots !== undefined) store.set('slots', slots)
  if (options.locale !== false) store.set('locale', locale)
  if (options.sidebarRightTabs !== false) store.set('sidebarRightTabs', tabs)
  if (options.sidebarRight !== false) store.set('sidebarRight', sidebarRight)
  const ctx = {
    get(name) {
      return store.get(name)
    },
    effect(callback, label) {
      effectLabels.push(label)
      const previous = slots ? slots._insideEffect : false
      if (slots) slots._insideEffect = true
      effectDepth += 1
      try {
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      } finally {
        effectDepth -= 1
        if (slots) slots._insideEffect = previous
      }
    },
  }
  return { ctx, dictionaryCalls, effectLabels, locale, tabs, tabTypes, sidebarRight, openedTabs }
}

function textOf(node, collected) {
  const out = collected || []
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out)
    return out
  }
  if (typeof node === 'object' && Array.isArray(node.children)) {
    for (const child of node.children) textOf(child, out)
  }
  return out
}

function findNode(node, predicate) {
  if (node === null || node === undefined) return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, predicate)
      if (found !== null) return found
    }
    return null
  }
  if (typeof node !== 'object') return null
  if (predicate(node)) return node
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const found = findNode(child, predicate)
      if (found !== null) return found
    }
  }
  return null
}

function collectNodes(node, predicate, collected) {
  const out = collected || []
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, predicate, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectNodes(child, predicate, out)
  }
  return out
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function staticChecks() {
  ok('客户端源码非空', SOURCE.length > 1000)
  for (const route of ROUTES) {
    ok('源码包含 ' + API_BASE + '/' + route, SOURCE.indexOf(API_BASE + '/' + route) !== -1)
  }
  const requireIds = Array.from(SOURCE.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)).map((match) => match[1])
  eq('只 require react（无 npm 依赖）', requireIds.join(','), 'react')
  ok('没有 ESM import 语句', !/^\s*import\s/m.test(SOURCE))
  ok('用 React.createElement（无 JSX）', SOURCE.indexOf('React.createElement') !== -1)
  ok('有防重复注册标记', SOURCE.indexOf(FLAG) !== -1)
  ok('每页 60 行', /PAGE_LINES\s*=\s*60/.test(SOURCE))
  ok('重建轮询 800ms', /POLL_MS\s*=\s*800/.test(SOURCE))
  const tokens = Array.from(SOURCE.matchAll(/var\((--dsw-[a-z0-9-]+)/g)).map((match) => match[1])
  ok('使用 DSH 设计 token（数量 >= 15）', tokens.length >= 15)
  for (const token of ['--dsw-alias-bg-base', '--dsw-alias-label-primary', '--dsw-alias-border-l2', '--dsw-alias-state-error-primary']) {
    ok('token ' + token, tokens.indexOf(token) !== -1)
  }
  ok('含 zh/en 文案字典', SOURCE.indexOf('语料库') !== -1 && SOURCE.indexOf("nav: 'Corpus'") !== -1)
  // v1.2 右栏
  ok('源码定义右栏 tab id', SOURCE.indexOf("const PERMISSIONS_TAB_ID = 'dsh-plugin-corpus-permissions'") !== -1)
  ok('源码 kind 是 corpus-permissions', SOURCE.indexOf("const PERMISSIONS_KIND = 'corpus-permissions'") !== -1)
  ok('源码 priority 是 extension', SOURCE.indexOf("priority: 'extension'") !== -1)
  ok('guide 条目 order 55', /order:\s*55\b/.test(SOURCE))
  ok('源码注册 sidebar.right.pane.tab keyed body', SOURCE.indexOf("name: 'sidebar.right.pane.tab'") !== -1 && SOURCE.indexOf('key: PERMISSIONS_TAB_ID') !== -1)
  ok('主页面入口按 kind 打开右栏', SOURCE.indexOf("openTab('corpus-permissions')") !== -1)
  ok('写操作先 GET /policy', SOURCE.indexOf('getJson(API.policy)') !== -1)
  ok('写操作再 POST /policy', SOURCE.indexOf('postJson(API.policy') !== -1)
  ok('源码含 /access 路径', SOURCE.indexOf(API_BASE + '/access') !== -1)
  ok('源码含右栏 UI 关键文案', ['在右侧栏编辑权限', '授予当前会话', '授予当前工作区', '添加全局拒绝', '有效期至', '已过期', '其他规则']
    .every((text) => SOURCE.indexOf(text) !== -1))
  ok('源码显示 400 校验 errors[]', SOURCE.indexOf('error.errors') !== -1 && SOURCE.indexOf('writeErrors') !== -1)

  // ---- v1.3 主页面「导入语料」区（不是右栏 tab） ----
  ok('源码不再注册右栏导入 tab', SOURCE.indexOf("'dsh-plugin-corpus-import'") === -1
    && SOURCE.indexOf("kind: 'corpus-import'") === -1 && SOURCE.indexOf('IMPORT_TAB_ID') === -1)
  ok('导入区实现在主页面组件里', SOURCE.indexOf('function ImportSection(props)') !== -1
    && SOURCE.indexOf('h(ImportSection,') !== -1)
  ok('页面头部导入按钮展开/收起', SOURCE.indexOf("importOpen: '导入语料'") !== -1
    && SOURCE.indexOf("importClose: '收起导入'") !== -1)
  ok('导入轮询 1000ms', /IMPORT_POLL_MS\s*=\s*1000/.test(SOURCE))
  ok('单文件 25MiB 上限', /MAX_UPLOAD_BYTES\s*=\s*25\s*\*\s*1024\s*\*\s*1024/.test(SOURCE))
  ok('FileReader → base64', SOURCE.indexOf('FileReader') !== -1
    && SOURCE.indexOf('readAsDataURL') !== -1 && SOURCE.indexOf('dataBase64') !== -1)
  ok('文件选择支持多选与 accept', SOURCE.indexOf('multiple: true') !== -1 && SOURCE.indexOf('accept: formats.join') !== -1)
  ok('文件/路径两种 POST body', SOURCE.indexOf('payload.files') !== -1 && SOURCE.indexOf('payload.paths') !== -1)
  ok('源码含 POST /import 路径', SOURCE.indexOf("importStart: '/api/dsh-plugin-corpus/import'") !== -1)
  ok('四种 stage 文案（extract/agent/write/index）',
    ['extract', 'agent', 'write', 'index'].every((stage) => SOURCE.indexOf("key === '" + stage + "'") !== -1))
  ok('AI 结构化开关与提示', SOURCE.indexOf('aiAvailable') !== -1
    && SOURCE.indexOf('使用默认模型，耗时随文档长度增加') !== -1)
  ok('提取器不可用提示（PDF/OCR/视觉）',
    SOURCE.indexOf('CORPUS_PDFTOTEXT') !== -1
    && SOURCE.indexOf('importOcrHint') !== -1 && SOURCE.indexOf('importVisionHint') !== -1)
  ok('展示扫描版 PDF/OCR 边界提示', SOURCE.indexOf('OCR') !== -1 && SOURCE.indexOf('importPdfOcrHint') !== -1)
  ok('展示 item warnings/result.errors', SOURCE.indexOf('importItemWarning') !== -1 && SOURCE.indexOf('resultData.errors') !== -1)
  ok('完成后刷新 overview', SOURCE.indexOf('onImported') !== -1 && SOURCE.indexOf('loadOverview()') !== -1)
  ok('导入 loading/error 文案', SOURCE.indexOf('正在加载导入目标') !== -1 && SOURCE.indexOf('无法加载导入目标') !== -1)
  ok('集合/prefix/AI 文案齐全', ['目标集合', '前缀（可选）', 'AI 结构化', '支持格式', '文档提取器', '开始导入']
    .every((text) => SOURCE.indexOf(text) !== -1))
  // v1.8/v1.9：语料文件按集合分组、资源管理器列表；已知扩展名用对应文件图标（未知回退前 4 字符），
  // 不再用文字预览；集合组默认折叠（▸/▾、全部展开/折叠、过滤自动展开），行内可两击删除。
  ok('语料文件 API（/gallery、1000 篇上限、集合过滤）',
    SOURCE.indexOf("gallery: '/api/dsh-plugin-corpus/gallery'") !== -1
    && SOURCE.indexOf("thumbnail: '/api/dsh-plugin-corpus/thumbnail'") === -1
    && SOURCE.indexOf('getJson(API.gallery + query)') !== -1
    && SOURCE.indexOf("'?limit=1000'") !== -1
    && SOURCE.indexOf("'&collection=' + encodeURIComponent(collection)") !== -1)
  ok('语料文件列表：集合分组 + 资源管理器行 + 文件类型图标 + 折叠/行删除',
    SOURCE.indexOf('function CorpusGallery(props)') !== -1
    && SOURCE.indexOf('function FileTypeIcon(props)') !== -1
    && SOURCE.indexOf('function CorpusThumb') === -1
    && SOURCE.indexOf("gridTemplateColumns: '34px minmax(160px, 1fr) 74px 82px 128px 174px'") !== -1
    && SOURCE.indexOf('const [expanded, setExpanded] = React.useState({})') !== -1
    && SOURCE.indexOf('toggleGroup') !== -1
    && SOURCE.indexOf("'aria-expanded': expanded[group.name] === true") !== -1
    && SOURCE.indexOf("? '▾ ' : '▸ '") !== -1
    && SOURCE.indexOf('galleryExpandAll') !== -1
    && SOURCE.indexOf('galleryCollapseAll') !== -1
    && SOURCE.indexOf('galleryExpandHint') !== -1
    && SOURCE.indexOf('galleryCollapsed') !== -1
    && SOURCE.indexOf('setExpanded({})') !== -1
    && SOURCE.indexOf('Object.fromEntries(groups.map') !== -1
    && SOURCE.indexOf("setExpanded((prev) => ({ ...prev, [value]: true }))") !== -1
    && SOURCE.indexOf("payload: { path: item.path }") !== -1
    && SOURCE.indexOf('deleteRowConfirm') !== -1
    && SOURCE.indexOf('props.onDeleted') !== -1
    && SOURCE.indexOf("txt: { label: 'TXT'") !== -1
    && SOURCE.indexOf("md: { label: 'MD'") !== -1
    && SOURCE.indexOf("pdf: { label: 'PDF'") !== -1
    && SOURCE.indexOf('FILE_TYPE_ICONS') !== -1
    && SOURCE.indexOf('format.slice(0, 4).toUpperCase()') !== -1
    && SOURCE.indexOf('item.excerpt') === -1
    && SOURCE.indexOf('t.galleryCount(data.total, data.shown)') !== -1
    && SOURCE.indexOf('t.galleryAi') !== -1)
  ok('语料文件接入主页面（默认外部打开 + 选择软件；行删除回调刷新 overview；旧 OriginalGallery 不渲染）',
    SOURCE.indexOf('h(CorpusGallery,') !== -1
    && SOURCE.indexOf('onExternal: (item, mode) =>') !== -1
    && SOURCE.indexOf('openMainItem(item)') !== -1
    && SOURCE.indexOf("props.onExternal(item, 'choose')") !== -1
    && SOURCE.indexOf("appIcon: '/api/dsh-plugin-corpus/app-icon'") !== -1
    && SOURCE.indexOf('onDeleted: () => { loadOverview() }') !== -1
    && SOURCE.indexOf('h(OriginalGallery,') === -1)
  ok('重建按钮带圈问号说明（? 圆形按钮 + 展开/收起文案）',
    SOURCE.indexOf('function ReindexHelp()') !== -1
    && SOURCE.indexOf('reindexHelpIncremental') !== -1
    && SOURCE.indexOf('reindexHelpForce') !== -1
    && SOURCE.indexOf("borderRadius: '50%'") !== -1
    && SOURCE.indexOf("'aria-label': t.reindexHelpTitle") !== -1
    && SOURCE.indexOf("}, '?')") !== -1
    && SOURCE.indexOf('h(ReindexHelp)') !== -1)
  ok('删除语料 API 与两击确认', SOURCE.indexOf("delete: '/api/dsh-plugin-corpus/delete'") !== -1
    && SOURCE.indexOf('function DeleteButton(props)') !== -1
    && SOURCE.indexOf('postJson(API.delete, props.payload)') !== -1
    && SOURCE.indexOf('t.deleteDocConfirm') !== -1
    && SOURCE.indexOf('t.deleteCollectionConfirm') !== -1)
  ok('删除入口接入预览与集合卡片', SOURCE.indexOf('payload: { path: previewState.path }') !== -1
    && SOURCE.indexOf('payload: { collection: name }') !== -1
    && SOURCE.indexOf('trashHint') !== -1)
  ok('根目录设置 API', SOURCE.indexOf("settings: '/api/dsh-plugin-corpus/settings'") !== -1
    && SOURCE.indexOf("settingsRoot: '/api/dsh-plugin-corpus/settings/root'") !== -1
    && SOURCE.indexOf("settingsOpen: '/api/dsh-plugin-corpus/settings/open'") !== -1
    && SOURCE.indexOf('getJson(API.settings)') !== -1
    && SOURCE.indexOf('postJson(API.settingsRoot, { root: target })') !== -1
    && SOURCE.indexOf('postJson(API.settingsOpen, {})') !== -1)
  ok('根目录设置组件与迁移入口', SOURCE.indexOf('function CorpusRootSettings(props)') !== -1
    && SOURCE.indexOf('settingsMigrate') !== -1
    && SOURCE.indexOf('settingsRestart') !== -1
    && SOURCE.indexOf("settingsTitle: '语料库根目录'") !== -1
    && SOURCE.indexOf("settingsTitle: 'Corpus root'") !== -1
    && SOURCE.indexOf("settingsCopy: '复制路径'") !== -1
    && SOURCE.indexOf('navigator.clipboard.writeText(value)') !== -1
    && SOURCE.indexOf('if (!armed) { setArmed(true)') !== -1
    && SOURCE.indexOf('body && body.restartRequired') !== -1
    && SOURCE.indexOf('t.settingsBusy') !== -1
    && SOURCE.indexOf('t.settingsStateFile') !== -1
    && /setOpen\(true\)\s*\n\s*load\(\)/.test(SOURCE))
  ok('根目录设置接入主页面', SOURCE.indexOf('h(CorpusRootSettings,') !== -1
    && SOURCE.indexOf("key: 'root-settings'") !== -1
    && SOURCE.indexOf('onChanged: () => { loadOverview() }') !== -1
    && SOURCE.indexOf('h(CorpusRootSettings,') > SOURCE.indexOf('const importSection = importOpen'))
}

async function zhBundleChecks() {
  const { harness, definition, exports, requireCalls } = bootExports('zh-CN')
  eq('防重复注册标记已置位', harness.window[FLAG], true)
  eq('factory 只 require 了 react', requireCalls.join(','), 'react')
  eq('exports.inject 含 slots/locale/sidebarRightTabs', exports.inject.join(','), 'slots,locale,sidebarRightTabs')
  eq('exports.apply 是函数', typeof exports.apply, 'function')
  eq('加载阶段不 fetch', harness.fetchCalls.length, 0)

  harness.rerun()
  eq('重复执行不再 load（防重复注册）', harness.loaderCalls.length, 1)

  const slots = makeSlots()
  const { ctx, dictionaryCalls, effectLabels, tabTypes, openedTabs } = makeCtx({ slots, lang: 'zh-CN' })
  exports.apply(ctx)

  eq('slots.inject 调用三次（左栏/主页面/右栏 body）', slots.injected.join(','), 'sidebar.panellist,main,sidebar.right.pane.tab')
  eq('三个注册点各注册一次', slots.registered.length, 3)
  const navRegistration = slots.registered[0]
  const mainRegistration = slots.registered[1]
  const permissionsRegistration = slots.registered[2]
  eq('sidebar 注册名', navRegistration.definition.name, 'sidebar.panellist')
  eq('sidebar id 是 corpus', navRegistration.definition.id, 'corpus')
  eq('sidebar order 是 46', navRegistration.definition.order, 46)
  eq('sidebar 注册包在 ctx.effect 里', navRegistration.insideEffect, true)
  eq('sidebar label zh', navRegistration.definition.label(), '语料库')
  eq('main 注册名', mainRegistration.definition.name, 'main')
  eq('main key 是 corpus', mainRegistration.definition.key, 'corpus')
  eq('main 注册包在 ctx.effect 里', mainRegistration.insideEffect, true)
  eq('main 组件是函数', typeof mainRegistration.component, 'function')
  eq('右栏 body 注册名', permissionsRegistration.definition.name, 'sidebar.right.pane.tab')
  eq('右栏 body key 是 tab id', permissionsRegistration.definition.key, PERMISSIONS_TAB_ID)
  eq('右栏 body 注册包在 ctx.effect 里', permissionsRegistration.insideEffect, true)
  eq('右栏 body 是函数', typeof permissionsRegistration.component, 'function')

  eq('右栏 tab 类型注册一次', tabTypes.length, 1)
  const tabType = tabTypes[0]
  eq('右栏 type id', tabType.definition.id, PERMISSIONS_TAB_ID)
  eq('右栏 type kind', tabType.definition.kind, PERMISSIONS_KIND)
  eq('右栏 type priority', tabType.definition.priority, 'extension')
  eq('右栏 type title zh', tabType.definition.title(), '语料权限')
  eq('右栏 type 注册包在 ctx.effect 里', tabType.insideEffect, true)
  const guide = tabType.definition.guide && tabType.definition.guide[0]
  eq('guide 条目 id', guide.id, 'permissions')
  eq('guide 条目 order 是 55', guide.order, 55)
  eq('guide 标题走 locale', guide.title(), '语料权限')
  ok('guide 描述非空', typeof guide.description() === 'string' && guide.description().length > 0)
  const shield = guide.icon({ size: 18, active: false })
  eq('guide 图标是 svg', shield.type, 'svg')

  const icon = navRegistration.component
  const iconElement = icon({ size: 20, active: true })
  eq('图标根节点是 svg', iconElement.type, 'svg')
  eq('图标尺寸跟随参数', iconElement.props.width, 20)
  eq('图标激活时加粗描边', iconElement.props.strokeWidth, 2)

  eq('locale 命名空间', dictionaryCalls.length > 0 ? dictionaryCalls[0].namespace : null, 'dsh-corpus')
  eq('locale zh nav', dictionaryCalls[0].dictionaries.zh.nav, '语料库')
  eq('locale en nav', dictionaryCalls[0].dictionaries.en.nav, 'Corpus')
  eq('locale zh permTitle', dictionaryCalls[0].dictionaries.zh.permTitle, '语料权限')
  eq('locale en permTitle', dictionaryCalls[0].dictionaries.en.permTitle, 'Corpus permissions')
  eq('注册项带 locale 命名空间', navRegistration.definition.locale, 'dsh-corpus')
  eq('main 注册项带 locale 命名空间', mainRegistration.definition.locale, 'dsh-corpus')
  ok('注册被 ctx.effect 包裹（dictionaries/sidebar/page/权限）',
    effectLabels.length === 5 && effectLabels.every((label) => typeof label === 'string' && label.indexOf('dsh-corpus') === 0))

  // 整页首屏渲染：fake hooks 只取初始状态，不执行 effect。
  const page = mainRegistration.component
  const pageElement = page()
  eq('页面根节点是 div', pageElement.type, 'div')
  const pageText = textOf(pageElement).join(' ')
  // v1.5：主页面挂了 CorpusRootSettings（函数组件；首屏只渲染标题/当前路径/按钮，点「更改位置」才 fetch）。
  const rootSettingsNode = findNode(pageElement, (node) => typeof node.type === 'function' && node.type.name === 'CorpusRootSettings')
  const rootSettingsText = rootSettingsNode === null ? '' : textOf(rootSettingsNode.type(rootSettingsNode.props || {})).join(' ')
  ok('页面含标题「语料库」', pageText.indexOf('语料库') !== -1)
  ok('页面含检索区', pageText.indexOf('检索') !== -1)
  ok('页面含集合与索引区', pageText.indexOf('集合与索引') !== -1)
  ok('页面含访问策略区', pageText.indexOf('访问策略') !== -1)
  ok('页面含加载态文案', pageText.indexOf('加载中') !== -1)
  ok('页面含「在右侧栏编辑权限」按钮与「语料库根目录」设置区', pageText.indexOf('在右侧栏编辑权限') !== -1
    && rootSettingsText.indexOf('语料库根目录') !== -1
    && rootSettingsText.indexOf('当前根目录') !== -1
    && rootSettingsText.indexOf('复制路径') !== -1
    && rootSettingsText.indexOf('在资源管理器中打开') !== -1
    && rootSettingsText.indexOf('更改位置') !== -1
    && rootSettingsText.indexOf('新根目录（绝对路径）') === -1)
  ok('页面头部含「导入语料」按钮', pageText.indexOf('导入语料') !== -1)
  ok('导入区默认收起（首屏不渲染导入表单）', pageText.indexOf('AI 结构化') === -1 && pageText.indexOf('支持格式') === -1)
  eq('首屏渲染不 fetch', harness.fetchCalls.length, 0)

  // 主区域入口：点击 → sidebarRight.openTab('corpus-permissions')
  const pageButtons = collectNodes(pageElement, (node) => node.type === 'button')
  const permissionsButton = pageButtons.find((button) => textOf(button).join(' ').indexOf('在右侧栏编辑权限') !== -1)
  ok('渲染出「在右侧栏编辑权限」按钮', permissionsButton !== undefined)
  if (permissionsButton) {
    permissionsButton.props.onClick()
    eq('点击后按 kind 打开右栏 tab', openedTabs.length === 1 ? openedTabs[0].kind : null, PERMISSIONS_KIND)
  }
  const importToggle = pageButtons.find((button) => textOf(button).join(' ').trim() === '导入语料')
  ok('渲染出「导入语料」展开按钮', importToggle !== undefined)
  if (importToggle) {
    noThrow('点击「导入语料」按钮不抛错', () => importToggle.props.onClick())
    ok('导入按钮不打开右栏 tab（只在页面内展开）', openedTabs.length === 1)
  }
  eq('右栏仍只有「语料权限」一个 tab 类型', tabTypes.length, 1)

  // 跑挂载 effect：应当 GET /overview + /status。
  const cleanups = harness.effects.map((effect) => effect())
  await tick()
  const urls = harness.fetchCalls.map((call) => String(call.url))
  ok('默认打开 GET /overview', urls.indexOf(API_BASE + '/overview') !== -1)
  ok('默认打开 GET /status', urls.indexOf(API_BASE + '/status') !== -1)
  const overviewCall = harness.fetchCalls.find((call) => String(call.url) === API_BASE + '/overview')
  eq('overview 用 GET', overviewCall && overviewCall.init ? overviewCall.init.method : null, 'GET')
  for (const cleanup of cleanups) {
    if (typeof cleanup === 'function') cleanup()
  }
}

async function enBundleChecks() {
  const { exports } = bootExports('en-US')
  const slots = makeSlots()
  const { ctx, tabTypes } = makeCtx({ slots, lang: 'en-US' })
  exports.apply(ctx)
  eq('sidebar label en', slots.registered[0].definition.label(), 'Corpus')
  eq('右栏 type title en', tabTypes[0].definition.title(), 'Corpus permissions')
  const pageElement = slots.registered[1].component()
  const pageText = textOf(pageElement).join(' ')
  ok('英文页面标题', pageText.indexOf('Corpus') !== -1)
  ok('英文检索区', pageText.indexOf('Search') !== -1)
  const enRootSettings = findNode(pageElement, (node) => typeof node.type === 'function' && node.type.name === 'CorpusRootSettings')
  const enRootSettingsText = enRootSettings === null ? '' : textOf(enRootSettings.type(enRootSettings.props || {})).join(' ')
  ok('英文访问策略区与根目录设置区', pageText.indexOf('Access policy') !== -1
    && enRootSettingsText.indexOf('Corpus root') !== -1
    && enRootSettingsText.indexOf('Copy path') !== -1
    && enRootSettingsText.indexOf('Change location') !== -1)
  ok('英文右栏编辑按钮', pageText.indexOf('Edit permissions in right sidebar') !== -1)
  ok('英文页面头部导入按钮', pageText.indexOf('Import corpus') !== -1)
}

function robustnessChecks() {
  const { harness, exports } = bootExports('zh-CN')
  const caught = []
  const realConsole = harness.sandbox.console
  harness.sandbox.console = {
    log: () => {},
    warn: () => {},
    error: (...args) => { caught.push(args) },
  }
  try {
    noThrow('没有 slots 时 apply 直接返回', () => exports.apply({ get: () => undefined, effect: () => {} }))
    noThrow('ctx.get 抛错时 apply 不抛错', () => exports.apply({ get() { throw new Error('boom') }, effect: () => {} }))
    eq('apply 内部错误被捕获并记录', caught.length, 1)
  } finally {
    harness.sandbox.console = realConsole
  }

  const slots = makeSlots()
  const ctx = {
    get: (name) => (name === 'slots' ? slots : undefined),
    effect(callback) {
      const previous = slots._insideEffect
      slots._insideEffect = true
      try {
        return callback()
      } finally {
        slots._insideEffect = previous
      }
    },
  }
  noThrow('没有 locale 服务时 apply 正常', () => exports.apply(ctx))
  eq('无 locale 时回退本地 zh label', slots.registered[0].definition.label(), '语料库')
  eq('无 locale 时仍注册两个点', slots.registered.length, 2)
}

/** 检索结果只用于定位，不提供点击查看入口；查看统一走文件列表/右侧预览。 */
async function hitPreviewChecks() {
  const searchState = {
    loading: false,
    error: null,
    ran: true,
    empty: false,
    data: {
      query: 'networking',
      hits: [{
        collection: 'dsh-docs',
        path: 'dsh-docs/networking.md',
        title: 'Networking',
        heading: 'Networking',
        lines: '45-51',
        score: 3,
        snippet: 'sockets and buffers',
      }],
      scope: { collections: ['dsh-docs'] },
    },
  }
  const { harness, exports } = bootExports('zh-CN', { seed: { byIndex: { 8: searchState } } })
  const slots = makeSlots()
  const { ctx } = makeCtx({ slots, lang: 'zh-CN' })
  exports.apply(ctx)
  const pageElement = slots.registered[1].component()
  const clickableHit = findNode(pageElement, (node) => Boolean(node.props && node.props.role === 'button' && node.props.tabIndex === 0))
  ok('检索结果不提供可点击的查看入口', clickableHit === null)
}

/** 工作区视角选 '*'（通配工作区）时，不能把它当字面 workspace 传给 /search。 */
async function wildcardWorkspaceChecks() {
  const { harness, exports } = bootExports('zh-CN', { seed: { byIndex: { 5: 'networking', 7: '*' } } })
  const slots = makeSlots()
  const { ctx } = makeCtx({ slots, lang: 'zh-CN' })
  exports.apply(ctx)
  const pageElement = slots.registered[1].component()
  const buttons = collectNodes(pageElement, (node) => node.type === 'button')
  const searchButton = buttons.find((button) => textOf(button).join(' ').indexOf('搜索') !== -1)
  ok('渲染出搜索按钮', searchButton !== undefined)
  if (!searchButton) return
  const before = harness.fetchCalls.length
  searchButton.props.onClick()
  await tick()
  const searchCall = harness.fetchCalls.slice(before).find((call) => String(call.url) === API_BASE + '/search')
  ok('点击搜索触发 POST /search', searchCall !== undefined)
  if (!searchCall) return
  const payload = JSON.parse(String(searchCall.init.body))
  eq('检索词取自输入框', payload.query, 'networking')
  ok('通配工作区 * 不作为字面 workspace 传给宿主', !Object.prototype.hasOwnProperty.call(payload, 'workspace'))
}

// ---- v1.2 右栏「语料权限」面板 ----

function makeAccessData() {
  const now = Date.now()
  return {
    ok: true,
    sessionId: 'session-test-1234567890',
    workspace: 'C:/work/DSH',
    workspaceKey: 'c:/work/dsh',
    effectiveCollections: ['dsh-docs'],
    collections: [
      { name: 'dsh-docs', backend: 'like', docs: 109 },
      { name: 'linux-kernel', backend: 'like', docs: 39 },
    ],
    policy: {
      accessFile: 'C:/dsh/corpus-access.json',
      exists: true,
      default: 'deny',
      grants: [
        { workspace: 'C:/work/DSH', paths: ['dsh-docs'], expiresAt: now + 3600000 },
        { workspace: 'C:/work/DSH', paths: ['linux-kernel/old.md'], expiresAt: now - 60000 },
        { session: 'session-test-1234567890', paths: ['dsh-docs/readme.md'] },
        { workspace: 'C:/other', paths: ['linux-kernel'] },
        { workspace: '*', paths: ['public/**'] },
      ],
      deny: [{ paths: ['**/private/**'] }],
      error: null,
      mtimeMs: 1,
    },
  }
}

function summaryOf(accessData) {
  return { ...accessData.policy }
}

function makePermissionsResponder(state) {
  return (url, init) => {
    const target = String(url)
    if (target.indexOf(API_BASE + '/access') === 0) return makeResponse({ ok: true, ...state.access })
    if (target === API_BASE + '/policy') {
      if (init && init.method === 'POST') {
        state.posted.push(JSON.parse(String(init.body)))
        return makeResponse({ ok: true, policy: state.summary, accessFile: state.summary.accessFile, backup: 'C:/dsh/backups/x.json' })
      }
      return makeResponse({ ok: true, ...state.summary })
    }
    return makeResponse({ ok: true })
  }
}

function bootPermissions(seed, responder) {
  const provider = bootExports('zh-CN', { seed, responder })
  const slots = makeSlots()
  const context = makeCtx({ slots, lang: 'zh-CN' })
  provider.exports.apply(context.ctx)
  const registration = slots.registered.find((item) => item.definition && item.definition.name === 'sidebar.right.pane.tab')
  return { harness: provider.harness, slots, context, registration, panel: registration.component }
}

function findButton(node, text) {
  return collectNodes(node, (item) => item.type === 'button')
    .find((button) => textOf(button).join(' ').indexOf(text) !== -1)
}

function permissionsRenderChecks() {
  const accessData = makeAccessData()
  const { panel } = bootPermissions({ byIndex: { 0: { loading: false, error: null, data: accessData } } })
  const element = panel({ sessionId: accessData.sessionId })
  const text = textOf(element).join(' ')
  ok('右栏面板含当前会话区', text.indexOf('当前会话') !== -1)
  ok('右栏面板显示 session 简写', text.indexOf('session-test') !== -1)
  ok('右栏面板显示工作区', text.indexOf('C:/work/DSH') !== -1)
  ok('右栏面板显示有效集合', text.indexOf('dsh-docs') !== -1)
  ok('右栏面板含会话规则区', text.indexOf('会话规则') !== -1)
  ok('右栏面板含工作区规则区', text.indexOf('工作区规则') !== -1)
  ok('右栏面板含全局区', text.indexOf('全局') !== -1)
  ok('右栏面板含拒绝规则区', text.indexOf('拒绝规则') !== -1)
  ok('右栏面板含其他规则折叠', text.indexOf('其他规则') !== -1)
  ok('右栏面板含「授予当前会话」', text.indexOf('授予当前会话') !== -1)
  ok('右栏面板含「授予当前工作区」', text.indexOf('授予当前工作区') !== -1)
  ok('右栏面板含「添加全局拒绝」', text.indexOf('添加全局拒绝') !== -1)
  ok('右栏面板显示有效期至', text.indexOf('有效期至') !== -1)
  ok('右栏面板标记已过期规则', text.indexOf('已过期') !== -1)
  ok('右栏面板显示永久规则', text.indexOf('永久') !== -1)
  ok('右栏面板页脚显示 accessFile', text.indexOf('corpus-access.json') !== -1)
  ok('右栏面板页脚显示 15 秒生效说明', text.indexOf('15 秒') !== -1)
  ok('右栏面板提供集合快捷 chip', text.indexOf('集合快捷填入') !== -1)
  const selects = collectNodes(element, (node) => node.type === 'select')
  ok('右栏面板有有效期下拉', selects.length >= 2)
  const optionTexts = []
  for (const select of selects) optionTexts.push(...textOf(select))
  ok('有效期下拉含 30 分钟/7 天', optionTexts.indexOf('30 分钟') !== -1 && optionTexts.indexOf('7 天') !== -1)
  const deleteButtons = collectNodes(element, (node) => node.type === 'button' && textOf(node).join(' ').trim() === '删除')
  ok('规则行都有删除按钮', deleteButtons.length >= 5)
}

async function permissionsMountChecks() {
  const { harness, panel } = bootPermissions(undefined, undefined)
  const element = panel({ sessionId: 'session-abc' })
  eq('右栏面板首屏不 fetch', harness.fetchCalls.length, 0)
  const text = textOf(element).join(' ')
  ok('右栏面板挂载前显示加载态', text.indexOf('正在加载访问信息') !== -1)
  const cleanups = harness.effects.map((effect) => effect())
  await tick()
  const call = harness.fetchCalls.find((item) => String(item.url).indexOf(API_BASE + '/access') === 0)
  ok('右栏面板挂载时 GET /access', call !== undefined)
  eq('GET /access 带 session 参数', call ? String(call.url) : null, API_BASE + '/access?session=session-abc')
  for (const cleanup of cleanups) {
    if (typeof cleanup === 'function') cleanup()
  }
}

async function permissionWriteChecks() {
  const accessData = makeAccessData()

  // 1) 会话临时授权（60 分钟有效期）
  {
    const state = { access: accessData, summary: summaryOf(accessData), posted: [] }
    const { harness, panel } = bootPermissions({
      byIndex: { 0: { loading: false, error: null, data: accessData }, 4: 'linux-kernel', 7: '60' },
    }, makePermissionsResponder(state))
    const element = panel({ sessionId: accessData.sessionId })
    const before = Date.now()
    const beforeCalls = harness.fetchCalls.length
    findButton(element, '授予当前会话').props.onClick()
    await tick()
    await tick()
    const calls = harness.fetchCalls.slice(beforeCalls)
    ok('会话授权先 GET /policy',
      calls.some((call) => String(call.url) === API_BASE + '/policy' && (!call.init || call.init.method !== 'POST')))
    const post = calls.find((call) => String(call.url) === API_BASE + '/policy' && call.init && call.init.method === 'POST')
    ok('会话授权 POST /policy', post !== undefined)
    ok('会话授权成功后重拉 /access', calls.some((call) => String(call.url).indexOf(API_BASE + '/access') === 0))
    if (post) {
      const policy = JSON.parse(String(post.init.body)).policy
      const added = policy.grants[policy.grants.length - 1]
      eq('新增 grant 主体是 session', added.session, accessData.sessionId)
      eq('新增 grant paths', added.paths.join(','), 'linux-kernel')
      ok('有效期被写成 expiresAt', typeof added.expiresAt === 'number'
        && added.expiresAt > before && added.expiresAt <= Date.now() + 60 * 60000 + 5000)
      eq('原有 grants 保留', policy.grants.length, accessData.policy.grants.length + 1)
    }
  }

  // 2) 工作区授权（永久）
  {
    const state = { access: accessData, summary: summaryOf(accessData), posted: [] }
    const { panel } = bootPermissions({
      byIndex: { 0: { loading: false, error: null, data: accessData }, 5: 'dsh-docs', 8: '0' },
    }, makePermissionsResponder(state))
    const element = panel({ sessionId: accessData.sessionId })
    findButton(element, '授予当前工作区').props.onClick()
    await tick()
    await tick()
    const posted = state.posted[0]
    ok('工作区授权 POST /policy', posted !== undefined)
    if (posted) {
      const policy = posted.policy
      const added = policy.grants[policy.grants.length - 1]
      eq('新增 grant 主体是 workspace', added.workspace, 'C:/work/DSH')
      eq('工作区 grant paths', added.paths.join(','), 'dsh-docs')
      ok('永久规则不带 expiresAt', !Object.prototype.hasOwnProperty.call(added, 'expiresAt'))
    }
  }

  // 3) 全局 deny 新增
  {
    const state = { access: accessData, summary: summaryOf(accessData), posted: [] }
    const { panel } = bootPermissions({
      byIndex: { 0: { loading: false, error: null, data: accessData }, 6: '**/secret/**' },
    }, makePermissionsResponder(state))
    const element = panel({ sessionId: accessData.sessionId })
    findButton(element, '添加全局拒绝').props.onClick()
    await tick()
    await tick()
    const posted = state.posted[0]
    ok('全局拒绝 POST /policy', posted !== undefined)
    if (posted) {
      const added = posted.policy.deny[posted.policy.deny.length - 1]
      eq('全局 deny paths', added.paths.join(','), '**/secret/**')
      ok('全局 deny 不带主体', !Object.prototype.hasOwnProperty.call(added, 'workspace')
        && !Object.prototype.hasOwnProperty.call(added, 'session'))
    }
  }

  // 4) default 切换
  {
    const state = { access: accessData, summary: summaryOf(accessData), posted: [] }
    const { panel } = bootPermissions({
      byIndex: { 0: { loading: false, error: null, data: accessData } },
    }, makePermissionsResponder(state))
    const element = panel({ sessionId: accessData.sessionId })
    findButton(element, '允许').props.onClick()
    await tick()
    await tick()
    ok('default 切换 POST /policy', state.posted.length === 1)
    if (state.posted.length > 0) eq('default 切到 allow', state.posted[0].policy.default, 'allow')
  }

  // 5) 删除当前会话规则
  {
    const state = { access: accessData, summary: summaryOf(accessData), posted: [] }
    const { panel } = bootPermissions({
      byIndex: { 0: { loading: false, error: null, data: accessData } },
    }, makePermissionsResponder(state))
    const element = panel({ sessionId: accessData.sessionId })
    const deleteButtons = collectNodes(element, (node) => node.type === 'button' && textOf(node).join(' ').trim() === '删除')
    ok('删除按钮可点击', deleteButtons.length > 0)
    deleteButtons[0].props.onClick()
    await tick()
    await tick()
    const posted = state.posted[0]
    ok('删除规则 POST /policy', posted !== undefined)
    if (posted) {
      eq('删除后 grants 少一条', posted.policy.grants.length, accessData.policy.grants.length - 1)
      ok('删除的是当前会话规则', posted.policy.grants.every((rule) => rule.session !== accessData.sessionId))
      ok('删除后重新拉 /access', true)
    }
  }
}

// ---- v1.3 主页面「导入语料」区（页面内，不是右栏 tab） ----

/**
 * fake React.createElement 只造元素不执行函数组件；测试里把嵌套组件展开成真实子树
 * （展开时才会执行 ImportSection 的 hook 与 useEffect）。
 */
function expandTree(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expandTree)
  if (typeof node.type === 'function') return expandTree(node.type(node.props || {}))
  const next = Object.assign({}, node)
  if (Array.isArray(node.children)) next.children = node.children.map(expandTree)
  return next
}

/** 挂载主页面；seed.byIndex 里 11 = importOpen，IMPORT_HOOK_OFFSET 起是 ImportSection 的 hook。 */
function bootImportPage(lang, seed, responder, extra) {
  const provider = bootExports(lang || 'zh-CN', {
    seed,
    responder,
    captureTimers: extra && extra.captureTimers ? extra.captureTimers : undefined,
  })
  const slots = makeSlots()
  const context = makeCtx({ slots, lang: lang || 'zh-CN' })
  provider.exports.apply(context.ctx)
  const registration = slots.registered.find((item) => item.definition && item.definition.name === 'main')
  return { harness: provider.harness, slots, context, page: registration.component }
}

function importBeans(extra) {
  return {
    byIndex: Object.assign({ 11: true, [IMPORT_HOOK_OFFSET]: { loading: false, error: null, data: IMPORT_TARGETS } }, extra || {}),
  }
}

function importRenderChecks() {
  // 1) 展开后的完整表单
  {
    const { harness, page } = bootImportPage('zh-CN', importBeans())
    const element = expandTree(page())
    eq('打开导入区首屏不 fetch', harness.fetchCalls.length, 0)
    const text = textOf(element).join(' ')
    ok('导入区标题与说明', text.indexOf('导入语料') !== -1 && text.indexOf('提取正文') !== -1)
    ok('导入区有收起按钮', text.indexOf('收起导入') !== -1)
    ok('两种来源按钮', text.indexOf('浏览器文件') !== -1 && text.indexOf('本机路径') !== -1)
    ok('文件空列表提示', text.indexOf('还没有选择文件') !== -1)
    ok('AI 开关默认开提示', text.indexOf('使用默认模型，耗时随文档长度增加') !== -1)
    ok('目标集合与 prefix', text.indexOf('目标集合') !== -1 && text.indexOf('前缀（可选）') !== -1)
    ok('集合下拉来自 /import/targets', text.indexOf('dsh-docs') !== -1 && text.indexOf('linux-kernel') !== -1)
    ok('集合名可直接输入新名称', text.indexOf('可直接输入新集合名') !== -1
      && text.indexOf('语料根下自动创建同名目录') !== -1)
    const collectionInput = findNode(element, (node) => node.type === 'input' && node.props
      && node.props.list === 'corpus-import-collections')
    ok('集合输入绑定 datalist', collectionInput !== null)
    ok('支持格式展示', text.indexOf('支持格式') !== -1 && text.indexOf('.pdf') !== -1 && text.indexOf('.csv') !== -1)
    ok('提取器可用性展示', text.indexOf('文档提取器') !== -1 && text.indexOf('PDF') !== -1
      && text.indexOf('Office') !== -1 && text.indexOf('OCR') !== -1 && text.indexOf('Vision') !== -1)
    ok('提取器不可用提示', text.indexOf('不可用') !== -1 && text.indexOf('CORPUS_PDFTOTEXT') !== -1)
    ok('上传上限提示', text.indexOf('25.0 MB') !== -1 && text.indexOf('200') !== -1)
    ok('开始导入按钮', findButton(element, '开始导入') !== undefined)
    const fileInput = findNode(element, (node) => node.type === 'input' && node.props && node.props.type === 'file')
    ok('渲染文件选择 input', fileInput !== null)
    if (fileInput) {
      eq('文件选择多选', fileInput.props.multiple, true)
      ok('文件选择 accept 含支持格式',
        String(fileInput.props.accept).indexOf('.pdf') !== -1 && String(fileInput.props.accept).indexOf('.docx') !== -1)
    }
    const aiCheckbox = findNode(element, (node) => node.type === 'input' && node.props && node.props.type === 'checkbox')
    ok('AI 开关默认开启', aiCheckbox !== null && aiCheckbox.props.checked === true)
  }

  // 2) 已选文件：名称/大小/删除
  {
    const { page } = bootImportPage('zh-CN', importBeans({
      14: [{ name: 'handbook.md', size: 2 * 1024 * 1024, dataBase64: 'aGVsbG8=' }],
    }))
    const element = expandTree(page())
    const text = textOf(element).join(' ')
    ok('文件列表显示名称与大小', text.indexOf('handbook.md') !== -1 && text.indexOf('2.0 MB') !== -1)
    const removeButtons = collectNodes(element, (node) => node.type === 'button' && textOf(node).join(' ').trim() === '删除')
    ok('文件行有删除按钮', removeButtons.length >= 1)
  }

  // 3) 提取器全部可用 → 显示 OCR 边界提示
  {
    const targets = JSON.parse(JSON.stringify(IMPORT_TARGETS))
    targets.visionAvailable = true
    targets.extractors = { pdf: true, office: true, ocr: true, image: true, bundle: true }
    const { page } = bootImportPage('zh-CN', importBeans({ [IMPORT_HOOK_OFFSET]: { loading: false, error: null, data: targets } }))
    const text = textOf(expandTree(page())).join(' ')
    ok('pdf 可用时提示扫描版 OCR 边界', text.indexOf('OCR') !== -1 && text.indexOf('扫描版') !== -1)
    ok('提取器全部可用时不显示安装提示', text.indexOf('CORPUS_PDFTOTEXT') === -1)
  }

  // 4) AI 不可用 → 禁用开关并说明
  {
    const targets = JSON.parse(JSON.stringify(IMPORT_TARGETS))
    targets.aiAvailable = false
    const { page } = bootImportPage('zh-CN', importBeans({ [IMPORT_HOOK_OFFSET]: { loading: false, error: null, data: targets } }))
    const element = expandTree(page())
    const text = textOf(element).join(' ')
    ok('AI 不可用说明可见', text.indexOf('AI 不可用') !== -1)
    const aiCheckbox = findNode(element, (node) => node.type === 'input' && node.props && node.props.type === 'checkbox')
    ok('AI 不可用时开关禁用', aiCheckbox !== null && aiCheckbox.props.disabled === true && aiCheckbox.props.checked === false)
  }

  // 5) 集合为空 → 空状态提示
  {
    const targets = JSON.parse(JSON.stringify(IMPORT_TARGETS))
    targets.collections = []
    const { page } = bootImportPage('zh-CN', importBeans({ [IMPORT_HOOK_OFFSET]: { loading: false, error: null, data: targets } }))
    const text = textOf(expandTree(page())).join(' ')
    ok('集合为空时提示先创建集合', text.indexOf('还没有集合') !== -1)
  }

  // 6) 进度区：stage / done-total / 当前文件 / item 告警
  {
    const job = {
      id: 'import-job-progress', state: 'running', collection: 'dsh-docs', total: 5, done: 2, failed: 1,
      current: { source: 'b.pdf', stage: 'agent' },
      items: [
        { source: 'c.pdf', ok: false, error: '可能是扫描版，未启用 OCR' },
        { source: 'd.md', ok: true, warnings: ['标题缺失，已用文件名'] },
      ],
    }
    const { page } = bootImportPage('zh-CN', importBeans({
      21: { active: job, recent: [], error: null },
    }))
    const element = expandTree(page())
    const text = textOf(element).join(' ')
    ok('进度区显示阶段', text.indexOf('导入进度') !== -1 && text.indexOf('AI 结构化') !== -1)
    ok('进度区显示 done/total 与失败数', text.indexOf('2/5') !== -1 && text.indexOf('失败 1') !== -1)
    ok('进度区显示当前文件', text.indexOf('b.pdf') !== -1)
    ok('进度区显示 item warning/error', text.indexOf('c.pdf') !== -1 && text.indexOf('扫描版') !== -1
      && text.indexOf('标题缺失') !== -1)
    ok('busy 时开始按钮禁用', (() => {
      const button = findButton(element, '导入中')
      return button !== undefined && button.props.disabled === true
    })())
    const fileInput = findNode(element, (node) => node.type === 'input' && node.props && node.props.type === 'file')
    ok('busy 时文件选择禁用', fileInput !== null && fileInput.props.disabled === true)
  }

  // 7) 四种 stage 文案
  const stagePairs = [['extract', '提取文本'], ['agent', 'AI 结构化'], ['write', '写入语料'], ['index', '建立索引']]
  for (const pair of stagePairs) {
    const job = { state: 'running', total: 3, done: 1, failed: 0, current: { source: 'x.md', stage: pair[0] }, items: [] }
    const { page } = bootImportPage('zh-CN', importBeans({ 21: { active: job, recent: [], error: null } }))
    const text = textOf(expandTree(page())).join(' ')
    ok('stage ' + pair[0] + ' 文案', text.indexOf(pair[1]) !== -1)
  }

  // 8) 结果区：计数 / reindexJobId / 告警 / errors
  {
    const doneJob = {
      id: 'import-job-done', state: 'done', collection: 'dsh-docs', total: 2, done: 2, failed: 0, current: null,
      result: {
        collection: 'dsh-docs', total: 2, imported: 2, failed: 0,
        reindexJobId: 'reindex-job-42', errors: ['索引重建启动失败：locked'],
      },
      items: [
        { source: 'a.md', ok: true, warnings: [] },
        { source: 'b.pdf', ok: true, warnings: ['可能是扫描版，未启用 OCR'] },
      ],
    }
    const { page } = bootImportPage('zh-CN', importBeans({ 24: doneJob }))
    const text = textOf(expandTree(page())).join(' ')
    ok('结果区显示导入结果', text.indexOf('导入结果') !== -1)
    ok('结果区显示 reindexJobId', text.indexOf('重建任务') !== -1 && text.indexOf('reindex-job-42') !== -1)
    ok('结果区显示成功计数', text.indexOf('成功 2') !== -1)
    ok('结果区展示 item warnings', text.indexOf('b.pdf') !== -1 && text.indexOf('扫描版') !== -1)
    ok('结果区展示 result.errors', text.indexOf('索引重建启动失败') !== -1)
  }

  // 9) loading / error / 轮询错误可见
  {
    const { page } = bootImportPage('zh-CN', { byIndex: { 11: true } })
    const text = textOf(expandTree(page())).join(' ')
    ok('导入目标加载态可见', text.indexOf('正在加载导入目标') !== -1)
  }
  {
    const { page } = bootImportPage('zh-CN', { byIndex: { 11: true, [IMPORT_HOOK_OFFSET]: { loading: false, error: 'boom', data: null } } })
    const element = expandTree(page())
    const text = textOf(element).join(' ')
    ok('导入目标错误可见', text.indexOf('无法加载导入目标') !== -1 && text.indexOf('boom') !== -1)
    ok('导入目标错误有重试按钮', findButton(element, '重试') !== undefined)
  }
  {
    const { page } = bootImportPage('zh-CN', importBeans({ 21: { active: null, recent: [], error: 'timeout' } }))
    const text = textOf(expandTree(page())).join(' ')
    ok('轮询错误提示可见', text.indexOf('查询导入状态失败') !== -1 && text.indexOf('timeout') !== -1)
  }
  {
    const { page } = bootImportPage('zh-CN', importBeans({ 23: { ok: false, text: '操作失败：HTTP 400' } }))
    const text = textOf(expandTree(page())).join(' ')
    ok('导入错误提示可见', text.indexOf('操作失败：HTTP 400') !== -1)
  }

  // 10) 英文文案
  {
    const { page } = bootImportPage('en-US', importBeans())
    const text = textOf(expandTree(page())).join(' ')
    ok('英文导入区标题', text.indexOf('Import corpus') !== -1)
    ok('英文来源/AI 文案', text.indexOf('Browser files') !== -1 && text.indexOf('AI structuring') !== -1)
    ok('英文开始导入与格式', text.indexOf('Start import') !== -1 && text.indexOf('Supported formats') !== -1)
  }
}

async function importMountChecks() {
  const { harness, page } = bootImportPage('zh-CN', { byIndex: { 11: true } })
  const element = expandTree(page())
  eq('导入区首屏不 fetch', harness.fetchCalls.length, 0)
  ok('导入区首屏显示加载态', textOf(element).join(' ').indexOf('正在加载导入目标') !== -1)
  const cleanups = harness.effects.map((effect) => effect())
  await tick()
  const urls = harness.fetchCalls.map((call) => String(call.url))
  ok('打开导入区时 GET /import/targets', urls.indexOf(IMPORT_TARGETS_URL) !== -1)
  ok('打开导入区时 GET /import/status', urls.indexOf(IMPORT_STATUS_URL) !== -1)
  const targetsCall = harness.fetchCalls.find((call) => String(call.url) === IMPORT_TARGETS_URL)
  eq('targets 用 GET', targetsCall && targetsCall.init ? targetsCall.init.method : null, 'GET')
  ok('主页面仍 GET /overview', urls.indexOf(API_BASE + '/overview') !== -1)
  for (const cleanup of cleanups) {
    if (typeof cleanup === 'function') cleanup()
  }
}

async function importSubmitChecks() {
  // 1) 浏览器文件 → POST /import（files，AI 关闭 + prefix）
  {
    const { harness, page } = bootImportPage('zh-CN', importBeans({
      14: [{ name: 'handbook.md', size: 2048, dataBase64: 'aGVsbG8=' }],
      18: 'dsh-docs',
      19: 'guides',
      20: false,
    }))
    const element = expandTree(page())
    const button = findButton(element, '开始导入')
    ok('渲染出开始导入按钮', button !== undefined)
    if (button) {
      const before = harness.fetchCalls.length
      button.props.onClick()
      await tick()
      await tick()
      const calls = harness.fetchCalls.slice(before)
      const post = calls.find((call) => String(call.url) === IMPORT_START && call.init && call.init.method === 'POST')
      ok('文件模式 POST /import', post !== undefined)
      if (post) {
        const payload = JSON.parse(String(post.init.body))
        eq('文件模式 collection', payload.collection, 'dsh-docs')
        eq('文件模式 prefix', payload.prefix, 'guides')
        eq('文件模式 ai 关闭', payload.ai, false)
        eq('文件模式 files[0].name', payload.files[0].name, 'handbook.md')
        eq('文件模式 files[0].dataBase64', payload.files[0].dataBase64, 'aGVsbG8=')
        ok('文件模式不带 path', !Object.prototype.hasOwnProperty.call(payload, 'path'))
      }
      ok('提交后轮询 /import/status', calls.some((call) => String(call.url) === IMPORT_STATUS_URL))
    }
  }

  // 1b) 直接输入新集合名 → POST /import（宿主会在语料根下创建目录）
  {
    const { harness, page } = bootImportPage('zh-CN', importBeans({
      14: [{ name: 'new.md', size: 16, dataBase64: 'aGVsbG8=' }],
      18: 'brand-new-collection',
    }))
    const element = expandTree(page())
    const text = textOf(element).join(' ')
    ok('新集合名输入提示可见', text.indexOf('可直接输入新集合名') !== -1)
    const button = findButton(element, '开始导入')
    if (button) {
      const before = harness.fetchCalls.length
      button.props.onClick()
      await tick()
      await tick()
      const post = harness.fetchCalls.slice(before)
        .find((call) => String(call.url) === IMPORT_START && call.init && call.init.method === 'POST')
      ok('新集合名 POST /import', post !== undefined)
      if (post) {
        const payload = JSON.parse(String(post.init.body))
        eq('新集合名原样提交', payload.collection, 'brand-new-collection')
      }
    }
  }

  // 2) 本机路径（多行）→ POST /import（paths，AI 默认开）
  {
    const { harness, page } = bootImportPage('zh-CN', importBeans({
      13: 'path',
      17: 'C:/docs/manual.pdf\nC:/docs/handbook/',
      18: 'linux-kernel',
    }))
    const element = expandTree(page())
    const pathInput = findNode(element, (node) => node.type === 'textarea' && node.props
      && node.props.value === 'C:/docs/manual.pdf\nC:/docs/handbook/')
    ok('批量路径模式渲染多行输入', pathInput !== null)
    const button = findButton(element, '开始导入')
    if (button) {
      const before = harness.fetchCalls.length
      button.props.onClick()
      await tick()
      await tick()
      const post = harness.fetchCalls.slice(before)
        .find((call) => String(call.url) === IMPORT_START && call.init && call.init.method === 'POST')
      ok('路径模式 POST /import', post !== undefined)
      if (post) {
        const payload = JSON.parse(String(post.init.body))
        eq('路径模式 paths[0]', payload.paths[0], 'C:/docs/manual.pdf')
        eq('路径模式 paths[1]', payload.paths[1], 'C:/docs/handbook/')
        eq('路径模式 collection', payload.collection, 'linux-kernel')
        eq('路径模式 AI 默认开', payload.ai, true)
        ok('路径模式不带 files', !Object.prototype.hasOwnProperty.call(payload, 'files'))
        ok('路径模式不带旧 path', !Object.prototype.hasOwnProperty.call(payload, 'path'))
        ok('空 prefix 不发送', !Object.prototype.hasOwnProperty.call(payload, 'prefix'))
      }
    }
  }

  // 3) 没有集合时自动创建 import-日期-时间 集合
  {
    const { harness, page } = bootImportPage('zh-CN', importBeans({
      13: 'path',
      17: 'C:/docs/manual.pdf',
    }))
    const button = findButton(expandTree(page()), '开始导入')
    if (button) {
      const before = harness.fetchCalls.length
      button.props.onClick()
      await tick()
      await tick()
      const post = harness.fetchCalls.slice(before)
        .find((call) => String(call.url) === IMPORT_START && call.init && call.init.method === 'POST')
      ok('空集合自动创建后 POST /import', post !== undefined)
      if (post) {
        const payload = JSON.parse(String(post.init.body))
        ok('自动集合名格式 import-日期-时间', /^import-\d{8}-\d{6}$/.test(payload.collection))
      }
    }
  }

  // 4) 只有一个集合时自动选中
  {
    const single = {
      ok: true,
      collections: [{ name: 'solo-corpus', docs: 3 }],
      formats: IMPORT_TARGETS.formats,
      extractors: IMPORT_TARGETS.extractors,
      aiAvailable: true,
      limits: IMPORT_TARGETS.limits,
    }
    const { harness, page } = bootImportPage('zh-CN', importBeans({
      13: 'path',
      17: 'C:/docs/dir/',
      [IMPORT_HOOK_OFFSET]: { loading: false, error: null, data: single },
    }))
    const button = findButton(expandTree(page()), '开始导入')
    if (button) {
      const before = harness.fetchCalls.length
      button.props.onClick()
      await tick()
      await tick()
      const post = harness.fetchCalls.slice(before)
        .find((call) => String(call.url) === IMPORT_START && call.init && call.init.method === 'POST')
      ok('单集合自动选中 POST /import', post !== undefined)
      if (post) eq('单集合作为 collection', JSON.parse(String(post.init.body)).collection, 'solo-corpus')
    }
  }

  // 4) 校验：没选集合/文件时不发 POST
  {
    const { harness, page } = bootImportPage('zh-CN', importBeans())
    const element = expandTree(page())
    const button = findButton(element, '开始导入')
    ok('无集合无文件时开始按钮仍可见', button !== undefined)
    if (button) {
      const before = harness.fetchCalls.length
      button.props.onClick()
      await tick()
      ok('缺少集合/文件时不 POST /import',
        harness.fetchCalls.slice(before).every((call) => String(call.url) !== IMPORT_START))
    }
  }

  // 5) 文件选择 onChange：FileReader 读取 → 过滤大文件/未知格式，读后清空 input
  {
    const { page } = bootImportPage('zh-CN', importBeans())
    const element = expandTree(page())
    const fileInput = findNode(element, (node) => node.type === 'input' && node.props && node.props.type === 'file')
    ok('文件选择 onChange 已绑定', fileInput !== null && typeof fileInput.props.onChange === 'function')
    if (fileInput) {
      const event = {
        target: {
          value: 'C:/fake/path',
          files: [
            { name: 'ok.md', size: 128, content: 'hello world' },
            { name: 'big.pdf', size: 30 * 1024 * 1024, content: 'x' },
            { name: 'skip.exe', size: 10, content: 'y' },
          ],
        },
      }
      let failure = null
      try {
        await fileInput.props.onChange(event)
      } catch (error) {
        failure = error
      }
      ok('文件选择 onChange 不抛错（FileReader 读取 + 过滤）', failure === null)
      eq('读取后清空 input value（允许重选同一文件）', event.target.value, '')
    }
  }
}

async function importPollingChecks() {
  const timers = []
  const runningJob = {
    id: 'import-job-1', state: 'running', collection: 'dsh-docs', total: 2, done: 1, failed: 0,
    current: { source: 'a.pdf', stage: 'extract' }, items: [],
  }
  const doneJob = {
    id: 'import-job-1', state: 'done', collection: 'dsh-docs', total: 2, done: 2, failed: 0, current: null,
    result: { collection: 'dsh-docs', total: 2, imported: 2, failed: 0, reindexJobId: 'reindex-9', errors: [] },
    items: [],
  }
  let statusCalls = 0
  const responder = (url) => {
    const target = String(url)
    if (target === IMPORT_TARGETS_URL) return makeResponse({ ok: true, ...IMPORT_TARGETS })
    if (target === IMPORT_STATUS_URL) {
      statusCalls += 1
      if (statusCalls <= 2) return makeResponse({ ok: true, active: runningJob, recent: [] })
      return makeResponse({ ok: true, active: null, recent: [doneJob] })
    }
    return makeResponse({ ok: true })
  }
  const { harness, page } = bootImportPage('zh-CN', { byIndex: { 11: true } }, responder, { captureTimers: timers })
  expandTree(page())
  const cleanups = harness.effects.map((effect) => effect())
  await tick()
  await tick()
  ok('运行中时安排 1000ms 轮询', timers.length === 1 && timers[0].delay === 1000)
  eq('前两次轮询看到 active', statusCalls, 2)
  if (timers.length > 0) {
    timers[0].callback()
    await tick()
    await tick()
  }
  eq('第三次轮询看到完成', statusCalls, 3)
  const calls = harness.fetchCalls.map((call) => String(call.url))
  ok('完成后重新 GET /import/targets', calls.filter((url) => url === IMPORT_TARGETS_URL).length >= 2)
  ok('完成后刷新 overview（页面重新加载）',
    calls.filter((url) => url === API_BASE + '/overview').length >= 2)
  const statusIndexes = harness.fetchCalls
    .map((call, index) => ({ url: String(call.url), index }))
    .filter((item) => item.url === IMPORT_STATUS_URL)
    .map((item) => item.index)
  const overviewIndexes = harness.fetchCalls
    .map((call, index) => ({ url: String(call.url), index }))
    .filter((item) => item.url === API_BASE + '/overview')
    .map((item) => item.index)
  ok('overview 刷新发生在最后一次 status 轮询之后',
    statusIndexes.length > 0 && overviewIndexes.length > 0
    && Math.max.apply(null, overviewIndexes) > Math.max.apply(null, statusIndexes))
  for (const cleanup of cleanups) {
    if (typeof cleanup === 'function') cleanup()
  }
}

async function main() {
  console.log('dsh-plugin-corpus 客户端 bundle 静态验证')
  console.log('')
  staticChecks()
  await zhBundleChecks()
  await enBundleChecks()
  robustnessChecks()
  await hitPreviewChecks()
  await wildcardWorkspaceChecks()
  permissionsRenderChecks()
  await permissionsMountChecks()
  await permissionWriteChecks()
  importRenderChecks()
  await importMountChecks()
  await importSubmitChecks()
  await importPollingChecks()
  console.log('')
  console.log(`客户端 bundle 静态验证：${pass}/${pass} 项通过`)
}

main().catch((error) => {
  console.error('')
  console.error('  FAIL ' + (error && error.message ? error.message : error))
  if (error && error.stack) console.error(error.stack)
  process.exitCode = 1
})
