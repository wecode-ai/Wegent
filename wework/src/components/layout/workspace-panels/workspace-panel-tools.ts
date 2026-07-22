import { configuredWorkspacePath } from '@/lib/project-workspace'
import type { RemoteTerminalClientFactory } from '@/lib/remote-terminal-socket'
import type { ProjectDeviceSessionResponse, ProjectWithTasks } from '@/types/api'

export type WorkspaceTool = 'terminal' | 'ide'

export type WorkspacePanelMenuTool = WorkspaceTool | 'desktop'

export interface WorkspacePanelMenuAction {
  visible: boolean
  disabled: boolean
  run: () => Promise<void>
}

export type WorkspacePanelMenuActions = Record<WorkspacePanelMenuTool, WorkspacePanelMenuAction>

export type WorkspaceTerminalSessionBase = ProjectDeviceSessionResponse & {
  cwd?: string
  title?: string
}

export type WorkspaceTerminalSession =
  | (WorkspaceTerminalSessionBase & {
      terminal_kind: 'local'
    })
  | (WorkspaceTerminalSessionBase & {
      terminal_kind: 'remote'
      remoteClientFactory: RemoteTerminalClientFactory
    })

export function getProjectDeviceId(project: ProjectWithTasks | null): string | undefined {
  return project?.config?.execution?.deviceId ?? project?.config?.device_id
}

export function getProjectLocalPath(project: ProjectWithTasks): string | undefined {
  return configuredWorkspacePath(project)
}

export function usesLocalProjectConfig(project: ProjectWithTasks | null): boolean {
  return Boolean(
    project &&
    (project.config?.execution?.targetType === 'local' ||
      project.config?.workspace?.source === 'local_path')
  )
}

function getPathBasename(path?: string | null): string {
  const normalizedPath = path?.trim().replace(/\/+$/, '')
  if (!normalizedPath || normalizedPath === '/') return ''
  return normalizedPath.split('/').filter(Boolean).pop() ?? ''
}

export function getTerminalSessionLabel(session: WorkspaceTerminalSessionBase | null): string {
  if (!session) return ''

  const title = session.title?.trim()
  if (title) return title

  return (
    getPathBasename(session.cwd) ||
    getPathBasename(session.path) ||
    session.device_id?.trim() ||
    session.session_id
  )
}

export function buildLocalTerminalEnv({
  title,
  projectName,
  workspacePath,
}: {
  title?: string | null
  projectName?: string | null
  workspacePath?: string | null
}): Record<string, string> | undefined {
  const normalizedTitle = title?.trim()
  if (!normalizedTitle) return undefined

  const env: Record<string, string> = {
    WEWORK_PARENT_TITLE: normalizedTitle,
  }
  const normalizedProjectName = projectName?.trim()
  const normalizedWorkspacePath = workspacePath?.trim()

  if (normalizedProjectName) {
    env.WEWORK_PARENT_PROJECT = normalizedProjectName
  }
  if (normalizedWorkspacePath) {
    env.WEWORK_PARENT_WORKSPACE = normalizedWorkspacePath
  }

  return env
}
