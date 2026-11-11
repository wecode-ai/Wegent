import type { ReleaseActivation } from '../runtime/release-store.js'

export type WorkbenchStartupMode = 'workbench' | 'application-only' | 'background-workbench'

interface WorkbenchStartupInput {
  hasApplicationRequest: boolean
  hasWorkbenchRequest: boolean
  activeReleaseId: string | undefined
  activation: Pick<ReleaseActivation, 'to' | 'token'> | null
  healthyActivationToken: string | null
}

/** A trial release must exercise the existing runtime and renderer health gate. */
export function workbenchStartupMode(input: WorkbenchStartupInput): WorkbenchStartupMode {
  if (!input.hasApplicationRequest || input.hasWorkbenchRequest) return 'workbench'
  const pendingActivation =
    input.activation &&
    input.activation.to === input.activeReleaseId &&
    input.healthyActivationToken !== input.activation.token
  return pendingActivation ? 'background-workbench' : 'application-only'
}

interface WorkbenchStartupActions {
  startWorkbench: () => Promise<unknown>
  openApplications: () => Promise<unknown>
  startControlBridge: () => Promise<unknown>
}

export async function startWorkbenchSession(
  mode: WorkbenchStartupMode,
  actions: WorkbenchStartupActions
): Promise<void> {
  // Host control and workbench health must never depend on untrusted app documents.
  if (mode === 'application-only') await actions.startControlBridge()
  else await actions.startWorkbench()
  await actions.openApplications()
}
