import type { DeviceInfo, ProjectWithTasks } from '@/types/api'
import type { EnvironmentDiffMode } from '@/api/environment'
import type { WorkspaceTarget } from '@/types/workspace-files'

export interface DesktopReviewState {
  loading: boolean
  diff: string
  error?: string
  reviewTitle?: string
  reviewMode?: DesktopReviewMode
  defaultFileTreeVisible?: boolean
  branchName?: string
  targetBranchName?: string
  focusFilePath?: string
  reloadDiff?: () => Promise<string>
}

export interface DesktopReviewMetadata {
  reviewTitle?: string
  reviewMode?: DesktopReviewMode
  defaultFileTreeVisible?: boolean
  branchName?: string
  targetBranchName?: string
  focusFilePath?: string
}

export type DesktopReviewMode = EnvironmentDiffMode | 'previous-turn'

export interface BottomPanelRenderContext {
  key: string
  currentProject: ProjectWithTasks | null
  devices: DeviceInfo[]
  workspaceTarget: WorkspaceTarget | null
  preferLocalTerminal: boolean
}

export function formatEnvironmentReviewErrorMessage({
  error,
  fallbackMessage,
  deviceUnavailableMessage,
}: {
  error: unknown
  fallbackMessage: string
  deviceUnavailableMessage: string
}): string {
  const message = error instanceof Error ? error.message : ''

  if (!message) {
    return fallbackMessage
  }

  if (isEnvironmentReviewDeviceConnectionError(message)) {
    return deviceUnavailableMessage
  }

  return message
}

function isEnvironmentReviewDeviceConnectionError(message: string): boolean {
  const normalizedMessage = message.toLowerCase()

  return (
    /device\s+'[^']+'\s+is\s+offline/i.test(message) ||
    (normalizedMessage.includes('device') && normalizedMessage.includes('offline')) ||
    (normalizedMessage.includes('command rpc timed out') && normalizedMessage.includes('device')) ||
    (normalizedMessage.includes('device:execute_command') &&
      normalizedMessage.includes('timed out'))
  )
}
