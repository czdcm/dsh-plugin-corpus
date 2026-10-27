/**
 * dsh-plugin-corpus — 索引重建的跨进程锁。
 *
 * 索引是每个集合一份 sqlite；同一台机器上可能有多个 DSH 进程（桌面 + CLI），
 * 两个进程同时重建同一批集合会出现 sqlite 锁竞争、甚至半截索引。这里用
 * <root>/.corpus/index/.lock 做单写者仲裁：
 *
 *   · 锁文件用 `wx` 原子创建，内容是 {pid, startedAt, names, token}；
 *   · 锁存在时看 pid 是否还活着、是否超过 2 小时；过期就清掉重试一次；
 *   · 释放时只删自己 token 的那把锁，避免误删别的新进程的锁。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LOCK_NAME = '.lock'
const STALE_MS = 2 * 60 * 60 * 1000

export function lockPath(root) {
  return path.join(root, '.corpus', 'index', LOCK_NAME)
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 说明进程存在但不属于当前用户，仍算活着。
    return Boolean(error && error.code === 'EPERM')
  }
}

/** 读锁文件；不存在/损坏返回 null。 */
export function readLock(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath(root), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 尝试取得重建锁。
 * @returns {{ok: true, token: string, release: () => void} | {ok: false, locked: object}}
 */
export function acquireLock(root, names = []) {
  const file = lockPath(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const payload = {
    pid: process.pid,
    startedAt: Date.now(),
    names: Array.isArray(names) ? names : [],
    token,
    host: os.hostname(),
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx')
      try { fs.writeFileSync(fd, JSON.stringify(payload)) } finally { fs.closeSync(fd) }
      return {
        ok: true,
        token,
        release() { releaseLock(root, token) },
      }
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
      const current = readLock(root)
      const stale = current === null
        || !pidAlive(Number(current.pid))
        || Date.now() - Number(current.startedAt || 0) > STALE_MS
      if (stale) {
        try { fs.rmSync(file, { force: true }) } catch { /* 交给下一次重试 */ }
        continue
      }
      return { ok: false, locked: current }
    }
  }
  return { ok: false, locked: readLock(root) }
}

/** 只释放 token 匹配的锁；已被别的进程接手时不动。 */
export function releaseLock(root, token) {
  try {
    const current = readLock(root)
    if (!current || current.token !== token) return false
    fs.rmSync(lockPath(root), { force: true })
    return true
  } catch {
    return false
  }
}
