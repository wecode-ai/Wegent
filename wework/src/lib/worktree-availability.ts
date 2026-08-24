import type {
  DeviceInfo,
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
  RuntimeWorktreeCapabilitiesResponse,
  RuntimeWorktreeCapabilitiesRequest,
  RuntimeWorktreeCapability,
  RuntimeWorktreePreflightRequest,
  RuntimeWorktreePreflightResponse,
} from '@/types/api'
import { isWorktreeEligibleProject } from './projectClassification'

export type ProjectWorktreeAvailabilityReason =
  | 'available'
  | 'no_project'
  | 'project_ineligible'
  | 'no_workspace'
  | 'workspace_unavailable'
  | 'workspace_not_base'
  | 'source_path_missing'
  | 'device_not_found'
  | 'device_mismatch'
  | 'device_offline'
  | 'executor_unsupported'
  | 'persistent_storage_unverified'
  | 'preflight_pending'
  | 'preflight_failed'
  | 'not_git'
  | 'worktree_root_unwritable'
  | 'workspace_identity_mismatch'

export interface ProjectWorktreeAvailability {
  available: boolean
  reason: ProjectWorktreeAvailabilityReason
  deviceId: string | null
  sourcePath: string | null
}

export interface ResolveProjectWorktreeAvailabilityInput {
  project: ProjectWithTasks | null | undefined
  workspace: RuntimeDeviceWorkspace | null | undefined
  device: DeviceInfo | null | undefined
  capabilities?: RuntimeWorktreeCapabilitiesResponse | null
  preflight?: RuntimeWorktreePreflightResponse | null
}

export interface ProjectWorktreeAvailabilityApi {
  getWorktreeCapabilities(
    data: RuntimeWorktreeCapabilitiesRequest
  ): Promise<RuntimeWorktreeCapabilitiesResponse>
  preflightWorktree(
    data: RuntimeWorktreePreflightRequest
  ): Promise<RuntimeWorktreePreflightResponse>
}

export interface ProbeProjectWorktreeAvailabilityInput extends Omit<
  ResolveProjectWorktreeAvailabilityInput,
  'capabilities' | 'preflight'
> {
  api: ProjectWorktreeAvailabilityApi
  ref?: string | null
}

function unavailable(
  reason: Exclude<ProjectWorktreeAvailabilityReason, 'available'>,
  deviceId: string | null,
  sourcePath: string | null
): ProjectWorktreeAvailability {
  return {
    available: false,
    reason,
    deviceId,
    sourcePath,
  }
}

export function worktreeWorkspaceDeviceId(
  workspace: RuntimeDeviceWorkspace | null | undefined
): string | null {
  if (!workspace) return null
  const remoteHostId = workspace.remoteHostId?.trim()
  if (workspace.workspaceSource === 'remote' && remoteHostId) return remoteHostId
  return workspace.deviceId.trim() || null
}

function deviceMatches(device: DeviceInfo, deviceId: string): boolean {
  if (device.device_id.trim() === deviceId) return true
  return Boolean(device.runtime_routes?.some(route => route.device_id.trim() === deviceId))
}

function projectedWorktreeCapability(
  device: Pick<DeviceInfo, 'runtime_features'>
): RuntimeWorktreeCapability | null {
  const runtimeFeatures = device.runtime_features
  if (!runtimeFeatures || runtimeFeatures.schemaVersion !== 1) return null
  return runtimeFeatures.worktrees ?? null
}

function supportsManagedWorktreeCapability(capability: RuntimeWorktreeCapability | null): boolean {
  return Boolean(
    capability && capability.version >= 1 && capability.managed && capability.preflight
  )
}

function requiresPersistentStorageVerification(device: Pick<DeviceInfo, 'device_type'>): boolean {
  return device.device_type !== 'local' && device.device_type !== 'app'
}

function hasVerifiedPersistentStorage(
  device: Pick<DeviceInfo, 'device_type'>,
  capability: RuntimeWorktreeCapability | null
): boolean {
  return (
    !requiresPersistentStorageVerification(device) || capability?.persistentStorageVerified === true
  )
}

export function deviceSupportsManagedWorktrees(
  device: Pick<DeviceInfo, 'device_type' | 'runtime_features'>
): boolean {
  const capability = projectedWorktreeCapability(device)
  return (
    supportsManagedWorktreeCapability(capability) &&
    hasVerifiedPersistentStorage(device, capability)
  )
}

function preflightFailureReason(
  preflight: RuntimeWorktreePreflightResponse
): Exclude<ProjectWorktreeAvailabilityReason, 'available'> | null {
  if (!preflight.success) return 'preflight_failed'
  if (!preflight.supported) return 'executor_unsupported'
  if (!preflight.sourceExists || !preflight.sourceDirectory) return 'source_path_missing'
  if (!preflight.gitRepository || !preflight.gitCommonDirValid) return 'not_git'
  if (!preflight.gitCommonDirWritable || !preflight.writable) {
    return 'worktree_root_unwritable'
  }

  switch (preflight.errorCode) {
    case null:
    case undefined:
      return null
    case 'runtime_feature_unsupported':
    case 'worktree_unsupported':
      return 'executor_unsupported'
    case 'worktree_source_missing':
      return 'source_path_missing'
    case 'worktree_source_not_git':
      return 'not_git'
    case 'worktree_git_common_dir_unwritable':
    case 'worktree_root_unwritable':
      return 'worktree_root_unwritable'
    case 'worktree_source_changed':
      return 'workspace_identity_mismatch'
    default:
      return 'preflight_failed'
  }
}

export function resolveProjectWorktreeAvailability({
  project,
  workspace,
  device,
  capabilities,
  preflight,
}: ResolveProjectWorktreeAvailabilityInput): ProjectWorktreeAvailability {
  const deviceId = worktreeWorkspaceDeviceId(workspace)
  const sourcePath = workspace?.workspacePath.trim() || null

  const structuralFailure = resolveStructuralFailure({
    project,
    workspace,
    device,
    deviceId,
    sourcePath,
  })
  if (structuralFailure) return structuralFailure
  if (!workspace) return unavailable('no_workspace', null, null)
  if (!device) return unavailable('device_not_found', deviceId, sourcePath)

  if (
    capabilities &&
    capabilities.deviceId !== deviceId &&
    !deviceMatches(device, capabilities.deviceId)
  ) {
    return unavailable('device_mismatch', deviceId, sourcePath)
  }
  if (capabilities && !capabilities.success) {
    return unavailable('executor_unsupported', deviceId, sourcePath)
  }

  const capability =
    capabilities === undefined
      ? projectedWorktreeCapability(device)
      : (capabilities?.runtimeWorktrees ?? null)
  if (!supportsManagedWorktreeCapability(capability)) {
    return unavailable('executor_unsupported', deviceId, sourcePath)
  }
  if (!hasVerifiedPersistentStorage(device, capability)) {
    return unavailable('persistent_storage_unverified', deviceId, sourcePath)
  }
  if (preflight === undefined || preflight === null) {
    return unavailable('preflight_pending', deviceId, sourcePath)
  }
  if (preflight.deviceId !== deviceId && !deviceMatches(device, preflight.deviceId)) {
    return unavailable('preflight_failed', deviceId, sourcePath)
  }
  const preflightFailure = preflightFailureReason(preflight)
  if (preflightFailure) {
    return unavailable(preflightFailure, deviceId, sourcePath)
  }
  if (
    workspace.repoRootFingerprint &&
    preflight.repoRootFingerprint &&
    workspace.repoRootFingerprint !== preflight.repoRootFingerprint
  ) {
    return unavailable('workspace_identity_mismatch', deviceId, sourcePath)
  }
  if (!preflight.repoRoot?.trim() || !preflight.resolvedWorktreeRoot?.trim()) {
    return unavailable('preflight_failed', deviceId, sourcePath)
  }

  return {
    available: true,
    reason: 'available',
    deviceId,
    sourcePath,
  }
}

function resolveStructuralFailure({
  project,
  workspace,
  device,
  deviceId,
  sourcePath,
}: ResolveProjectWorktreeAvailabilityInput & {
  deviceId: string | null
  sourcePath: string | null
}): ProjectWorktreeAvailability | null {
  if (!project) return unavailable('no_project', deviceId, sourcePath)
  if (!isWorktreeEligibleProject(project)) {
    return unavailable('project_ineligible', deviceId, sourcePath)
  }
  if (!workspace) return unavailable('no_workspace', null, null)
  if (!workspace.available) {
    return unavailable('workspace_unavailable', deviceId, sourcePath)
  }
  if (workspace.workspaceKind === 'worktree' || workspace.worktreeId) {
    return unavailable('workspace_not_base', deviceId, sourcePath)
  }
  if (!sourcePath) return unavailable('source_path_missing', deviceId, null)
  if (!device) return unavailable('device_not_found', deviceId, sourcePath)
  if (!deviceId || !deviceMatches(device, deviceId)) {
    return unavailable('device_mismatch', deviceId, sourcePath)
  }
  if (device.status !== 'online' && device.status !== 'busy') {
    return unavailable('device_offline', deviceId, sourcePath)
  }
  return null
}

function structuralAvailability(
  input: Omit<ResolveProjectWorktreeAvailabilityInput, 'capabilities' | 'preflight'>
): ProjectWorktreeAvailability {
  const deviceId = worktreeWorkspaceDeviceId(input.workspace)
  const sourcePath = input.workspace?.workspacePath.trim() || null
  return (
    resolveStructuralFailure({
      ...input,
      deviceId,
      sourcePath,
    }) ?? unavailable('preflight_pending', deviceId, sourcePath)
  )
}

function failedProbeAvailability(
  input: Omit<ResolveProjectWorktreeAvailabilityInput, 'capabilities' | 'preflight'>
): ProjectWorktreeAvailability {
  const structural = structuralAvailability(input)
  if (structural.reason !== 'preflight_pending') return structural
  return unavailable('preflight_failed', structural.deviceId, structural.sourcePath)
}

export async function probeProjectWorktreeAvailability({
  api,
  project,
  workspace,
  device,
  ref,
}: ProbeProjectWorktreeAvailabilityInput): Promise<ProjectWorktreeAvailability> {
  const input = { project, workspace, device }
  const structural = structuralAvailability(input)
  if (structural.reason !== 'preflight_pending' || !structural.deviceId || !structural.sourcePath) {
    return structural
  }

  try {
    const capabilities = await api.getWorktreeCapabilities({
      deviceId: structural.deviceId,
    })
    const capabilityAvailability = resolveProjectWorktreeAvailability({
      ...input,
      capabilities,
      preflight: null,
    })
    if (capabilityAvailability.reason !== 'preflight_pending') {
      return capabilityAvailability
    }

    const preflight = await api.preflightWorktree({
      deviceId: structural.deviceId,
      sourcePath: structural.sourcePath,
      ...(ref?.trim() ? { ref: ref.trim() } : {}),
    })
    return resolveProjectWorktreeAvailability({
      ...input,
      capabilities,
      preflight,
    })
  } catch (error) {
    console.error('[Wework] Worktree availability probe failed', error)
    return failedProbeAvailability(input)
  }
}
