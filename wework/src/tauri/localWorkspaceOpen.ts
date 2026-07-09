import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { isTauriRuntime } from '@/lib/runtime-environment'

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

function normalizedRequest(request: LocalWorkspaceOpenRequest): LocalWorkspaceOpenRequest | null {
  const path = request.path?.trim()
  if (!path) return null
  const label = request.label?.trim()
  return {
    path,
    ...(label ? { label } : {}),
  }
}

export async function takePendingLocalWorkspaceOpenRequests(): Promise<
  LocalWorkspaceOpenRequest[]
> {
  if (!isTauriRuntime()) return []
  const requests = await invoke<LocalWorkspaceOpenRequest[]>(
    TAKE_PENDING_LOCAL_WORKSPACE_OPEN_REQUESTS_COMMAND
  )
  return requests.map(normalizedRequest).filter(Boolean) as LocalWorkspaceOpenRequest[]
}

export function installLocalWorkspaceOpenListener(
  openLocalWorkspace: OpenLocalWorkspaceHandler,
  onError?: (message: string) => void
): Promise<UnlistenFn> | null {
  if (!isTauriRuntime()) return null

  let drainPromise: Promise<void> | null = null
  let drainAgain = false

  const drainRequests = () => {
    if (drainPromise) {
      drainAgain = true
      return drainPromise
    }

    drainPromise = takePendingLocalWorkspaceOpenRequests()
      .then(async requests => {
        for (const request of requests) {
          await openLocalWorkspace(
            LOCAL_WORKSPACE_OPEN_DEVICE_ID,
            request.path,
            request.label ?? undefined
          )
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

  return listen(LOCAL_WORKSPACE_OPEN_REQUESTED_EVENT, () => {
    void drainRequests()
  }).catch(error => {
    console.error('[Wework] Failed to install local workspace open listener', error)
    onError?.(error instanceof Error ? error.message : 'Failed to install Wework CLI listener')
    return () => {}
  })
}
