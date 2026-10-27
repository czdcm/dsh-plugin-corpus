/**
 * dsh-plugin-corpus v1.5 — 语料库根目录设置与迁移。
 *
 * 根目录解析优先级：
 *   1. <DSH_HOME>/corpus-root.json（面板设置过，记录真实根目录与旧路径别名）
 *   2. config.corpusRoot
 *   3. <DSH_HOME>/corpus
 *
 * 迁移目标：把整个根目录（集合、.corpus/index、originals、thumbs 等）搬到新位置。
 * 同卷且支持目录联接时：rename + 旧路径 junction → 新路径，当前进程无需重启；
 * 否则：复制到新路径并保留旧路径，写 state 后提示重启，重启后使用新根目录。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const ROOT_STATE_NAME = 'corpus-root.json'

export function rootStatePath(dshHome) {
  return path.join(dshHome, ROOT_STATE_NAME)
}

export function readRootState(dshHome) {
  const file = rootStatePath(dshHome)
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || typeof parsed.root !== 'string' || parsed.root.trim() === '') return null
    const root = path.resolve(parsed.root)
    const aliases = Array.isArray(parsed.aliases)
      ? parsed.aliases.filter((item) => typeof item === 'string' && path.isAbsolute(item)).map((item) => path.resolve(item))
      : []
    return {
      root,
      aliases,
      previous: typeof parsed.previous === 'string' ? path.resolve(parsed.previous) : '',
      mode: typeof parsed.mode === 'string' ? parsed.mode : 'junction',
      migratedAt: typeof parsed.migratedAt === 'string' ? parsed.migratedAt : '',
      restartRequired: parsed.restartRequired === true,
    }
  } catch {
    return null
  }
}

export function writeRootState(dshHome, state) {
  fs.mkdirSync(dshHome, { recursive: true })
  const file = rootStatePath(dshHome)
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak')
  } catch { /* 备份失败不阻塞 */ }
  const temp = file + '.tmp-' + process.pid + '-' + Date.now()
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8')
  fs.renameSync(temp, file)
}

/** 现有 config.corpusRoot 的 ~ 展开；state 优先。 */
export function expandRoot(value, dshHome) {
  const state = readRootState(dshHome)
  if (state !== null && fs.existsSync(state.root)) return state.root
  if (typeof value !== 'string' || value.trim() === '') return path.join(dshHome, 'corpus')
  let text = value.trim()
  if (text === '~') return os.homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) text = path.join(os.homedir(), text.slice(2))
  return path.resolve(text)
}

function isInside(parent, child) {
  const parentAbs = path.resolve(parent)
  const childAbs = path.resolve(child)
  return childAbs === parentAbs || childAbs.startsWith(parentAbs + path.sep)
}

function removeAlias(alias) {
  let stat
  try { stat = fs.lstatSync(alias) } catch { return false }
  if (!stat.isSymbolicLink()) return false
  try {
    fs.rmdirSync(alias)
    return true
  } catch {
    try { fs.unlinkSync(alias); return true } catch { return false }
  }
}

function makeAlias(target, alias) {
  fs.mkdirSync(path.dirname(alias), { recursive: true })
  if (fs.existsSync(alias) || (() => { try { fs.lstatSync(alias); return true } catch { return false } })()) {
    if (!removeAlias(alias)) return false
  }
  try {
    fs.symlinkSync(target, alias, 'junction')
    return true
  } catch {
    return false
  }
}

/** 测试当前文件系统是否支持创建 junction（不依赖管理员权限）。 */
function supportsJunction(parent) {
  const stamp = 'corpus-junction-test-' + process.pid + '-' + Date.now()
  const target = path.join(parent, stamp + '-target')
  const link = path.join(parent, stamp + '-link')
  try {
    fs.mkdirSync(target, { recursive: true })
    fs.symlinkSync(target, link, 'junction')
    fs.rmdirSync(link)
    fs.rmdirSync(target)
    return true
  } catch {
    try { if (fs.existsSync(link)) fs.rmdirSync(link) } catch { /* ignore */ }
    try { if (fs.existsSync(target)) fs.rmdirSync(target) } catch { /* ignore */ }
    return false
  }
}

function copyRoot(source, target) {
  fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: false })
}

function validatePaths(currentRoot, newPath) {
  const current = path.resolve(currentRoot)
  const raw = String(newPath || '').trim()
  if (raw === '' || !path.isAbsolute(raw)) throw new Error('新根目录必须是绝对路径')
  const target = path.resolve(raw)
  if (current === target) throw new Error('新根目录与当前根目录相同')
  if (isInside(current, target)) throw new Error('新根目录不能位于当前语料库内部')
  if (isInside(target, current)) throw new Error('当前根目录不能位于新根目录内部')
  let currentStat
  try { currentStat = fs.lstatSync(current) } catch { throw new Error(`当前语料库根目录不存在：${current}`) }
  if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) throw new Error('当前语料库根目录不是普通目录，无法迁移')
  if (fs.existsSync(target)) {
    const targetStat = fs.lstatSync(target)
    if (!targetStat.isDirectory()) throw new Error('新根目录已存在且不是目录')
    if (fs.readdirSync(target).length > 0) throw new Error('新根目录已存在且非空，请换一个空目录或新路径')
    fs.rmdirSync(target)
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  return { current, target }
}

/**
 * 迁移整个语料库根目录。
 * 调用方必须先停止导入/重建任务（settings 路由负责检查）。
 * @returns {{ok:true, mode:'junction'|'copy', root:string, previous:string, aliases:string[], restartRequired:boolean}}
 */
export function migrateRoot({ dshHome, currentRoot, newRoot }) {
  const runtimeRoot = path.resolve(currentRoot)
  const state = readRootState(dshHome)
  const source = state !== null && fs.existsSync(state.root) ? state.root : runtimeRoot
  if (!fs.existsSync(source)) throw new Error(`已记录的语料库根目录不存在：${source}`)
  const { current, target } = validatePaths(source, newRoot)
  const moveSource = current
  if (path.resolve(moveSource) === path.resolve(target)) throw new Error('新根目录与迁移源相同')

  const parent = path.dirname(target)
  fs.mkdirSync(parent, { recursive: true })
  const junction = supportsJunction(parent)
  let mode = 'copy'
  let aliases = []

  if (junction) {
    try {
      fs.renameSync(moveSource, target)
      mode = 'junction'
    } catch {
      // 跨卷/被占用：退回复制，保留旧目录，等重启后使用新根目录。
      copyRoot(moveSource, target)
      mode = 'copy'
    }
  } else {
    copyRoot(moveSource, target)
    mode = 'copy'
  }

  if (mode === 'junction') {
    const previousAliases = state !== null && Array.isArray(state.aliases) ? state.aliases : []
    aliases = [...new Set([...previousAliases.map((item) => path.resolve(item)), path.resolve(moveSource), runtimeRoot])]
      .filter((item) => path.resolve(item) !== path.resolve(target))
    let runtimeOk = false
    for (const alias of aliases) {
      if (makeAlias(target, alias)) {
        if (path.resolve(alias) === runtimeRoot) runtimeOk = true
      }
    }
    if (!runtimeOk) {
      // 无法把当前运行路径接到新目录：回滚，避免当前进程读写断掉。
      for (const alias of aliases) removeAlias(alias)
      try {
        fs.renameSync(target, moveSource)
        throw new Error('无法为当前语料库路径创建目录联接，已回滚（数据未迁移）')
      } catch (error) {
        if (error instanceof Error && error.message.includes('已回滚')) throw error
        copyRoot(target, moveSource)
        throw new Error('无法为当前语料库路径创建目录联接，已复制回原路径（数据未删除）')
      }
    }
  }

  const nextState = {
    root: path.resolve(target),
    aliases,
    previous: path.resolve(moveSource),
    mode,
    migratedAt: new Date().toISOString(),
    restartRequired: mode !== 'junction',
  }
  writeRootState(dshHome, nextState)
  return {
    ok: true,
    mode,
    root: nextState.root,
    previous: nextState.previous,
    aliases,
    restartRequired: nextState.restartRequired,
  }
}
