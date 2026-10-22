import type { LocalExecutorStatus } from '@/desktop/localExecutor'
import type { RuntimeWorkListResponse } from '@/types/api'
import { DshExecutorTransportError } from '@/api/dsh/executorTransport'

/** Renderer-only provenance; never part of an Executor RPC payload. */
export interface LocalRuntimeSidebarIdentity {
  deviceId: string
  runtimeInstanceId: string
  provenance: 'local-ipc'
}

export interface LocalRuntimeSidebarOptions {
  localSidebarIdentity?: LocalRuntimeSidebarIdentity
}

// Trusted IPC provenance survives immutable spreads but is absent from JSON and RPC payloads.
const localRuntimeSource = Symbol('local-runtime-source')
type LocalRuntimeSource = { [localRuntimeSource]?: LocalRuntimeSidebarIdentity }

export function getLocalRuntimeSourceIdentity(
  value: object
): LocalRuntimeSidebarIdentity | undefined {
  return (value as LocalRuntimeSource)[localRuntimeSource]
}

export function qualifyLocalRuntimeSource<T extends object>(
  value: T,
  identity: LocalRuntimeSidebarIdentity
): T {
  return { ...value, [localRuntimeSource]: identity }
}

export function qualifyLocalRuntimeWork(
  work: RuntimeWorkListResponse,
  identity: LocalRuntimeSidebarIdentity
): RuntimeWorkListResponse {
  const qualifyWorkspace = (workspace: RuntimeWorkListResponse['chats'][number]) =>
    workspace.deviceId === identity.deviceId &&
    !workspace.remoteHostId &&
    workspace.workspaceSource !== 'remote'
      ? qualifyLocalRuntimeSource(workspace, identity)
      : workspace
  return {
    ...work,
    projects: work.projects.map(projectWork => ({
      ...projectWork,
      project:
        (projectWork.project.stateDeviceId ?? projectWork.deviceWorkspaces[0]?.deviceId) ===
        identity.deviceId
          ? qualifyLocalRuntimeSource(projectWork.project, identity)
          : projectWork.project,
      deviceWorkspaces: projectWork.deviceWorkspaces.map(qualifyWorkspace),
    })),
    chats: work.chats.map(qualifyWorkspace),
  }
}

export function localRuntimeSidebarIdentity(
  status: LocalExecutorStatus
): LocalRuntimeSidebarIdentity {
  if (!status.running || status.ready === false || status.error) {
    throw new Error('local-sidebar-executor-offline')
  }
  const deviceId = status.deviceId?.trim()
  const runtimeInstanceId = status.runtimeInstanceId?.trim()
  if (!deviceId || !runtimeInstanceId) throw new Error('local-sidebar-identity-unavailable')
  return { deviceId, runtimeInstanceId, provenance: 'local-ipc' }
}

export function isInvalidLocalRuntimeIdentityError(error: unknown): boolean {
  return (
    (error instanceof DshExecutorTransportError && error.code === 'protocol_mismatch') ||
    (error instanceof Error &&
      (error.message === 'local-sidebar-identity-unavailable' ||
        error.message === 'local-sidebar-runtime-changed'))
  )
}

export function assertLocalRuntimeSidebarIdentity(
  expected: LocalRuntimeSidebarIdentity,
  current: LocalRuntimeSidebarIdentity | null
): void {
  if (
    expected.provenance !== 'local-ipc' ||
    !expected.deviceId.trim() ||
    !expected.runtimeInstanceId.trim() ||
    !current ||
    current.provenance !== 'local-ipc' ||
    expected.deviceId !== current.deviceId ||
    expected.runtimeInstanceId !== current.runtimeInstanceId
  ) {
    throw new Error('local-sidebar-runtime-changed')
  }
}
