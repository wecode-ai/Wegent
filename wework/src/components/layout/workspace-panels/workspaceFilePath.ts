function normalizeWorkspaceFilePath(path: string) {
  const normalized = path.trim().replace(/\\/g, '/').replace(/\/+/g, '/')
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '')
}

export function workspaceRelativeFilePath(rootPath: string, filePath: string): string | null {
  const root = normalizeWorkspaceFilePath(rootPath)
  const file = normalizeWorkspaceFilePath(filePath)

  if (!root || !file || file === root) return null
  const rootPrefix = root === '/' ? root : `${root}/`
  return file.startsWith(rootPrefix) ? file.slice(rootPrefix.length) : null
}
