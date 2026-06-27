const PARENT_TRAVERSAL_ERROR = 'Workspace path cannot contain parent traversal'

export function normalizeDevicePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, '/')
  if (!trimmed) return ''

  const absolute = trimmed.startsWith('/')
  const segments: string[] = []

  for (const segment of trimmed.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) {
        throw new Error(PARENT_TRAVERSAL_ERROR)
      }
      segments.pop()
      continue
    }
    segments.push(segment)
  }

  const normalized = segments.join('/')
  if (absolute) return normalized ? `/${normalized}` : '/'
  return normalized
}

export function normalizeRelativeWorkspacePath(path: string): string {
  const normalized = normalizeDevicePath(path.replace(/^\/+/, ''))
  if (normalized.startsWith('/')) return normalized.slice(1)
  return normalized
}

export function joinDevicePath(root: string, ...segments: string[]): string {
  const normalizedRoot = normalizeDevicePath(root)
  const absolute = normalizedRoot.startsWith('/') || root.trim().startsWith('/')
  const parts = [
    absolute ? normalizedRoot.replace(/^\/+|\/+$/g, '') : normalizedRoot,
    ...segments.map(segment => normalizeRelativeWorkspacePath(segment)),
  ].filter(Boolean)

  const joined = parts.join('/')
  if (absolute) return joined ? `/${joined}` : '/'
  return joined
}

export function devicePathBasename(path: string, fallback = 'project'): string {
  return normalizeDevicePath(path).split('/').filter(Boolean).at(-1) || fallback
}

export function devicePathDirname(path: string): string {
  const normalized = normalizeDevicePath(path)
  const absolute = normalized.startsWith('/')
  const segments = normalized.split('/').filter(Boolean)
  if (segments.length <= 1) return absolute ? '/' : ''
  const dirname = segments.slice(0, -1).join('/')
  return absolute ? `/${dirname}` : dirname
}

export function executorWorkspaceRoot(projectWorkspaceRoot: string): string {
  const normalizedRoot = normalizeDevicePath(projectWorkspaceRoot)
  return devicePathBasename(normalizedRoot) === 'projects'
    ? devicePathDirname(normalizedRoot) || '/'
    : normalizedRoot
}

export function buildManagedWorktreePath({
  projectWorkspaceRoot,
  sourceWorkspacePath,
  worktreeId,
}: {
  projectWorkspaceRoot: string
  sourceWorkspacePath: string
  worktreeId: number | string
}): string {
  return joinDevicePath(
    executorWorkspaceRoot(projectWorkspaceRoot),
    'worktrees',
    String(worktreeId),
    devicePathBasename(sourceWorkspacePath)
  )
}
