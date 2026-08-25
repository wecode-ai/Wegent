import type { UnlistenFn } from './disposeDesktopListener'

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
  return []
}

export function installLocalWorkspaceOpenListener(
  openLocalWorkspace: OpenLocalWorkspaceHandler,
  onError?: (message: string) => void
): Promise<UnlistenFn> | null {
  void openLocalWorkspace
  void onError
  return null
}
