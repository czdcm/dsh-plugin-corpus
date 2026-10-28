/**
 * 集合名规则：目录名同时也是集合名。
 *
 * 允许中文、字母、数字、空格和常见符号；拒绝路径分隔符、Windows 非法字符、
 * 控制字符、隐藏/相对目录、Windows 保留设备名，以及超长名称。
 */
export const MAX_COLLECTION_LENGTH = 64

const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/
const INVALID_START = /^[^\p{L}\p{N}]/u
const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

export function normalizeCollectionName(value) {
  return String(value === undefined || value === null ? '' : value).normalize('NFC')
}

export function isValidCollectionName(value) {
  const name = normalizeCollectionName(value)
  if (name === '' || name !== name.trim()) return false
  if (Array.from(name).length > MAX_COLLECTION_LENGTH) return false
  if (name.endsWith('.') || name.endsWith(' ')) return false
  if (INVALID_CHARS.test(name) || INVALID_START.test(name)) return false
  if (RESERVED_WINDOWS.test(name)) return false
  return true
}

export function collectionNameError(value) {
  const name = normalizeCollectionName(value)
  if (name === '') return '集合名不能为空'
  if (name !== name.trim()) return '集合名不能以空格开头或结尾'
  if (Array.from(name).length > MAX_COLLECTION_LENGTH) return `集合名最多 ${MAX_COLLECTION_LENGTH} 个字符`
  if (name.endsWith('.') || name.endsWith(' ')) return '集合名不能以点或空格结尾'
  if (RESERVED_WINDOWS.test(name)) return `集合名不能使用 Windows 保留名：${name}`
  if (INVALID_CHARS.test(name)) return '集合名不能包含路径分隔符或 Windows 非法字符：/ \\ : * ? " < > |'
  if (INVALID_START.test(name)) return '集合名必须以中文、字母或数字开头'
  return '集合名不合法'
}
