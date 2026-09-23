import { normalizeAbsoluteWorkspacePath } from '@/lib/workspace-file-contract'
import type { WorkspaceTarget } from '@/types/workspace-files'

export type WorkspaceFileTabId = `file:${string}`

export interface WorkspaceFileTab {
  target: WorkspaceTarget
  path: string
}

export type WorkspaceFileTabs = Partial<Record<WorkspaceFileTabId, WorkspaceFileTab>>

export function isWorkspaceFileTab(tab: string): tab is WorkspaceFileTabId {
  return tab.startsWith('file:')
}

export function workspaceFileTabId(target: WorkspaceTarget, path: string): WorkspaceFileTabId {
  const normalized = normalizeAbsoluteWorkspacePath(path, 'Workspace file path must be absolute')
  const identity =
    /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')
      ? normalized.toLowerCase()
      : normalized
  return `file:${encodeURIComponent(JSON.stringify([target.deviceId, target.workspaceSource ?? '', identity]))}`
}

export function workspaceFileTabLabel(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? path
}
