import {
  isAbsoluteWorkspacePath,
  normalizeAbsoluteWorkspacePath,
  normalizeWorkspaceSeparators,
} from '@/lib/workspace-file-contract'
import type { WorkspaceTarget } from '@/types/workspace-files'

export function resolveWorkspaceFilePath(target: WorkspaceTarget, path: string): string | null {
  const normalizedPath = normalizeWorkspaceSeparators(path, target.path)
  if (!normalizedPath) return null
  if (isAbsoluteWorkspacePath(normalizedPath, target.path)) {
    try {
      return normalizeAbsoluteWorkspacePath(normalizedPath, 'Workspace file path must be absolute')
    } catch {
      return null
    }
  }

  const root = normalizeWorkspaceSeparators(target.path).replace(/\/+$/, '') || '/'
  const prefix = root.endsWith('/') ? root : `${root}/`
  const relativePath = normalizeWorkspaceSeparators(`${prefix}${normalizedPath}`).slice(
    prefix.length
  )
  const segments: string[] = []
  for (const segment of relativePath.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') return null
    segments.push(segment)
  }
  if (segments.length === 0) return null

  const child = segments.join('/')
  return root === '/' ? `/${child}` : `${root}/${child}`
}

export function workspaceParentPath(path: string): string {
  const normalized = path.replace(/\/+$/, '')
  const separatorIndex = normalized.lastIndexOf('/')
  const parentPath = separatorIndex > 0 ? normalized.slice(0, separatorIndex) : '/'
  return /^[a-zA-Z]:$/.test(parentPath) ? `${parentPath}/` : parentPath
}
