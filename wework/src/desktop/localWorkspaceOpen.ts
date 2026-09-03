import type { UnlistenFn } from './disposeDesktopListener'
import { invokeDesktopHost, subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'

export const LOCAL_WORKSPACE_OPEN_REQUESTED_EVENT = 'wework-open-local-workspace-requested'
export const TAKE_PENDING_LOCAL_WORKSPACE_OPEN_REQUESTS_COMMAND =
  'take_pending_local_workspace_open_requests'
export const LOCAL_WORKSPACE_OPEN_DEVICE_ID = 'local-device'

export interface LocalWorkspaceOpenRequest {
  path: string
  label?: string | null
}

export type OpenLocalWorkspaceHandler = (
  deviceId: string,
  workspacePath: string,
  label?: string
) => Promise<void>

export async function takePendingLocalWorkspaceOpenRequests(): Promise<
  LocalWorkspaceOpenRequest[]
> {
  return invokeDesktopHost<LocalWorkspaceOpenRequest[]>('workspace.takePendingOpenRequests')
}

export function installLocalWorkspaceOpenListener(
  openLocalWorkspace: OpenLocalWorkspaceHandler,
  onError?: (message: string) => void
): Promise<UnlistenFn> | null {
  let drainPromise: Promise<void> | null = null
  let drainAgain = false

  const drainRequests = (): Promise<void> => {
    if (drainPromise) {
      drainAgain = true
      return drainPromise
    }
    drainPromise = takePendingLocalWorkspaceOpenRequests()
      .then(async requests => {
        for (const request of requests) {
          const path = request.path?.trim()
          if (!path) continue
          const label = request.label?.trim()
          await openLocalWorkspace(LOCAL_WORKSPACE_OPEN_DEVICE_ID, path, label || undefined)
        }
      })
      .catch(error => {
        const message =
          error instanceof Error ? error.message : 'Failed to open local workspace from CLI'
        console.error('[Wework] Failed to open local workspace from CLI:', error)
        onError?.(message)
      })
      .finally(() => {
        drainPromise = null
        if (drainAgain) {
          drainAgain = false
          void drainRequests()
        }
      })
    return drainPromise
  }

  void drainRequests()
  const unsubscribe = subscribeDesktopHostEvents(event => {
    if (event.type === LOCAL_WORKSPACE_OPEN_REQUESTED_EVENT) void drainRequests()
  })
  return Promise.resolve(unsubscribe)
}
