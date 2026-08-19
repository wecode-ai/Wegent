function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * Returns the path relative to a workspace root. Returns '' when the path is
 * the root itself; paths outside the root fall back to the path without
 * leading separators so callers can still render a usable label.
 */
export function workspaceRelativePath(rootPath: string, path: string): string {
  const root = normalizeWorkspacePath(rootPath)
  const target = normalizeWorkspacePath(path)

  if (!root || target === root) return ''
  if (target.startsWith(`${root}/`)) return target.slice(root.length + 1)
  return target.replace(/^\/+/, '')
}
