/**
 * 外部查看器的“文件类型 → 应用”记忆。
 *
 * 映射写在 <root>/.corpus/openers.json，例如：
 *   { "md": { "name": "VS Code", "path": "C:\\...\\Code.exe" } }
 * 只保存用户明确选择过的应用；没有映射时仍回退 Windows 文件关联/打开方式。
 */
import fs from 'node:fs'
import path from 'node:path'

const OPENER_FILE = '.corpus/openers.json'
const MAX_APPS = 30

function envPath(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || value.trim() === '') return null
  return value.trim()
}

/** 常见已安装应用；不依赖注册表也能覆盖记事本/VS Code 等。 */
function candidatePaths() {
  const local = envPath('LOCALAPPDATA')
  const roaming = envPath('APPDATA')
  const pf = envPath('ProgramFiles')
  const pf86 = envPath('ProgramFiles(x86)')
  const windir = envPath('WINDIR') || 'C:\\Windows'
  const list = []
  const add = (name, file) => { if (file) list.push({ name, path: file }) }
  add('记事本', path.join(windir, 'notepad.exe'))
  add('VS Code', local && path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'))
  add('VS Code', pf && path.join(pf, 'Microsoft VS Code', 'Code.exe'))
  add('VS Code', pf86 && path.join(pf86, 'Microsoft VS Code', 'Code.exe'))
  add('VS Code Insiders', local && path.join(local, 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe'))
  add('Notepad++', pf && path.join(pf, 'Notepad++', 'notepad++.exe'))
  add('Notepad++', pf86 && path.join(pf86, 'Notepad++', 'notepad++.exe'))
  add('Notepad++', local && path.join(local, 'Programs', 'Notepad++', 'notepad++.exe'))
  add('Typora', local && path.join(local, 'Programs', 'Typora', 'Typora.exe'))
  add('Typora', pf && path.join(pf, 'Typora', 'Typora.exe'))
  add('Obsidian', local && path.join(local, 'Obsidian', 'Obsidian.exe'))
  add('Obsidian', pf && path.join(pf, 'Obsidian', 'Obsidian.exe'))
  add('Sublime Text', pf && path.join(pf, 'Sublime Text', 'sublime_text.exe'))
  add('Sublime Text', pf && path.join(pf, 'Sublime Text 3', 'sublime_text.exe'))
  add('Windows 记事本', roaming && path.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Accessories', 'Notepad.lnk'))
  return list
}

function normalizeExt(value) {
  const ext = String(value || '').trim().toLowerCase().replace(/^\./, '')
  if (!/^[a-z0-9][a-z0-9_.-]{0,15}$/.test(ext)) return ''
  return ext
}

function openerPath(root) {
  return path.join(root, '.corpus', 'openers.json')
}

export function readOpeners(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(openerPath(root), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function openerFor(root, filePath) {
  const ext = normalizeExt(path.extname(String(filePath || '')))
  if (ext === '') return null
  const entry = readOpeners(root)[ext]
  if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') return null
  const app = validAppPath(entry.path)
  return app === null ? null : { name: typeof entry.name === 'string' ? entry.name : app, path: app }
}

export function validAppPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const abs = path.resolve(value.trim())
  if (!abs.toLowerCase().endsWith('.exe')) return null
  try {
    const stat = fs.lstatSync(abs)
    if (!stat.isFile() || stat.isSymbolicLink()) return null
    return fs.realpathSync(abs)
  } catch {
    return null
  }
}

export function saveOpener(root, filePath, app) {
  const ext = normalizeExt(path.extname(String(filePath || '')))
  const abs = validAppPath(app && app.path)
  if (ext === '' || abs === null) throw new Error('程序路径无效')
  const openers = readOpeners(root)
  openers[ext] = { name: String((app && app.name) || path.basename(abs)), path: abs }
  const file = openerPath(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(openers, null, 2), 'utf8')
}

export function listOpenerApps(root, extValue) {
  const ext = normalizeExt(extValue)
  const seen = new Set()
  const apps = []
  const current = ext === '' ? null : openerFor(root, 'x.' + ext)
  const add = (name, appPath) => {
    const abs = validAppPath(appPath)
    if (abs === null) return
    const key = abs.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    apps.push({ name: String(name || path.basename(abs)), path: abs })
  }
  if (current) add(current.name, current.path)
  for (const candidate of candidatePaths()) add(candidate.name, candidate.path)
  return { ext, apps: apps.slice(0, MAX_APPS), current }
}

export { normalizeExt, OPENER_FILE }
