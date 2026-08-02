export interface WorkspaceTabTransferState {
  draftInputByScope: Record<string, string>
}

const TRANSFER_STORAGE_PREFIX = 'wework.workspaceTabTransfer.v1:'
const liveStateByTabId = new Map<string, WorkspaceTabTransferState>()

function transferStorageKey(tabId: string): string {
  return `${TRANSFER_STORAGE_PREFIX}${tabId}`
}

export function publishWorkspaceTabTransferState(
  tabId: string,
  state: WorkspaceTabTransferState
): void {
  liveStateByTabId.set(tabId, state)
}

export function stageWorkspaceTabTransfer(tabId: string): void {
  const state = liveStateByTabId.get(tabId)
  if (!state) return
  localStorage.setItem(transferStorageKey(tabId), JSON.stringify(state))
}

export function consumeWorkspaceTabTransfer(tabId: string): WorkspaceTabTransferState | null {
  const key = transferStorageKey(tabId)
  const raw = localStorage.getItem(key)
  localStorage.removeItem(key)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as WorkspaceTabTransferState
    if (!parsed || typeof parsed.draftInputByScope !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

export function clearStagedWorkspaceTabTransfer(tabId: string): void {
  localStorage.removeItem(transferStorageKey(tabId))
}
