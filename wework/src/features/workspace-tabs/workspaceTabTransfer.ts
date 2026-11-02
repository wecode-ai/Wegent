import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'

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
  diagnoseTransfer('stage', tabId, state ?? null)
  if (!state) return
  localStorage.setItem(transferStorageKey(tabId), JSON.stringify(state))
}

export function consumeWorkspaceTabTransfer(tabId: string): WorkspaceTabTransferState | null {
  const key = transferStorageKey(tabId)
  const raw = localStorage.getItem(key)
  localStorage.removeItem(key)
  if (!raw) {
    diagnoseTransfer('consume', tabId, null)
    return null
  }
  try {
    const parsed = JSON.parse(raw) as WorkspaceTabTransferState
    if (!parsed || typeof parsed.draftInputByScope !== 'object') return null
    diagnoseTransfer('consume', tabId, parsed)
    return parsed
  } catch {
    return null
  }
}

function diagnoseTransfer(
  action: string,
  tabId: string,
  state: WorkspaceTabTransferState | null
): void {
  if (import.meta.env.VITE_WEWORK_E2E !== 'true') return
  const details = {
    action,
    tabId,
    windowLabel: getDesktopWindowLabel(),
    observedAt: new Date().toISOString(),
    scopes: Object.keys(state?.draftInputByScope ?? {}).length,
    characters: Object.values(state?.draftInputByScope ?? {}).reduce(
      (total, value) => total + (typeof value === 'string' ? value.length : 0),
      0
    ),
  }
  // Fingerprints identify stale transfers without retaining private drafts.
  const bytes = new TextEncoder().encode(JSON.stringify(state))
  void Promise.resolve()
    .then(() => crypto.subtle.digest('SHA-256', bytes))
    .then(
      digest => {
        logRuntimeTaskCreateStage('workspace-tab-transfer', {
          ...details,
          fingerprint: Array.from(new Uint8Array(digest), byte =>
            byte.toString(16).padStart(2, '0')
          ).join(''),
        })
      },
      () =>
        logRuntimeTaskCreateStage('workspace-tab-transfer', {
          ...details,
          fingerprintUnavailable: true,
        })
    )
}

export function clearStagedWorkspaceTabTransfer(tabId: string): void {
  localStorage.removeItem(transferStorageKey(tabId))
}
