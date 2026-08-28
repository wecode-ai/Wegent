export function normalizePath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed || trimmed === '/') return trimmed || '/'
  const windowsRoot = trimmed.match(/^([a-zA-Z]:)[\\/]*$/)
  if (windowsRoot) return `${windowsRoot[1]}\\`
  return trimmed.replace(/[\\/]+$/, '')
}

export function joinPath(parent: string, child: string): string {
  const normalizedParent = normalizePath(parent)
  if (!normalizedParent || normalizedParent === '/') return `/${child}`
  const separator = normalizedParent.includes('\\') ? '\\' : '/'
  return `${normalizedParent}${normalizedParent.endsWith(separator) ? '' : separator}${child}`
}

export function basename(path: string): string {
  const segments = normalizePath(path).split(/[\\/]/).filter(Boolean)
  return segments.at(-1) || 'project'
}

export function getParentPath(path: string): string {
  const normalized = normalizePath(path)
  const windowsDrive = normalized.match(/^([a-zA-Z]:)[\\/]/)
  const segments = normalized.split(/[\\/]/).filter(Boolean)
  if (windowsDrive) {
    if (segments.length <= 1) return `${windowsDrive[1]}\\`
    if (segments.length === 2) return `${windowsDrive[1]}\\`
    return `${windowsDrive[1]}\\${segments.slice(1, -1).join('\\')}`
  }
  if (segments.length <= 1) return '/'
  return `/${segments.slice(0, -1).join('/')}`
}

export function getPathSearchParts(path: string): { parentPath: string; query: string } {
  const trimmedPath = path.trim()
  if (!trimmedPath || trimmedPath === '/') {
    return { parentPath: '/', query: '' }
  }

  if (/[\\/]$/.test(trimmedPath)) {
    return { parentPath: normalizePath(trimmedPath), query: '' }
  }

  const normalized = normalizePath(trimmedPath)
  return {
    parentPath: getParentPath(normalized),
    query: basename(normalized),
  }
}

export function directoryMatchesQuery(directory: string, query: string): boolean {
  const normalizedDirectory = directory.toLowerCase()
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return true
  if (normalizedDirectory.includes(normalizedQuery)) return true

  let queryIndex = 0
  for (const character of normalizedDirectory) {
    if (character === normalizedQuery[queryIndex]) {
      queryIndex += 1
      if (queryIndex === normalizedQuery.length) return true
    }
  }
  return false
}
