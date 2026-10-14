import type {
  RuntimeProjectAiSettings,
  RuntimeProjectRef,
  RuntimeProjectSpaceRef,
  RuntimeLocalProjectUpsertResponse,
  DeviceInfo,
  RuntimeProjectWork,
  RuntimeWorkListResponse,
} from '@/types/api'
import type { ExecutorRuntimeClient } from '@/api/executorAccess'
import type { ProjectDevicePluginApi } from '@/api/projectDevicePlugins'
import {
  projectEditingCapabilities,
  type ProjectEditingCapabilities,
} from './project-editing-capabilities'
import { getRuntimeProjectOwner } from './runtime-project-state'
import { createWorkbenchDeviceResolver, workbenchDeviceMatchesId } from './workbench-device'
import {
  getRuntimeProjectLocalOwnerIdentity,
  runtimeProjectTargetKey,
} from './runtime-project-identity'
import type { RuntimeProjectUpdate } from './runtime-project-update'

export interface ProjectEditingSave {
  deviceId: string
  projectKey: string
  name: string
  roots: string[]
  defaultProjectSpace?: RuntimeProjectSpaceRef | null
  aiSettings?: RuntimeProjectAiSettings | null
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)])
    )
  }
  return value
}

export function projectSettingEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

export function normalizedProjectAi(settings: RuntimeProjectAiSettings | null | undefined) {
  return {
    instructions: settings?.instructions?.trim() || '',
    modelSelection: settings?.modelSelection ?? null,
    plugins: settings?.plugins ?? [],
    quickPhrases: settings?.quickPhrases ?? [],
  }
}

export function projectRoots(project: RuntimeProjectRef): string[] {
  return project.roots?.map(root => root.path) ?? []
}

export function findOwnedRuntimeProject(
  work: RuntimeWorkListResponse | null | undefined,
  device: DeviceInfo,
  projectKey: string,
  devices: DeviceInfo[]
) {
  const owners = createWorkbenchDeviceResolver(devices)
  const target = runtimeProjectTargetKey(device.device_id, projectKey, owners)
  const matches = work?.projects.filter(projectWork => {
    const owner = getRuntimeProjectOwner(projectWork)
    return (
      owner.projectKey === projectKey &&
      runtimeProjectTargetKey(
        owner.deviceId,
        owner.projectKey,
        owners,
        getRuntimeProjectLocalOwnerIdentity(projectWork, owner.deviceId)
      ) === target
    )
  })
  return matches?.length === 1 ? matches[0] : undefined
}

interface ProjectEditingSaveContext {
  device: DeviceInfo
  devices: DeviceInfo[]
  projectWork: RuntimeProjectWork
  runtime: ExecutorRuntimeClient
  pluginApi?: ProjectDevicePluginApi
  ensureSameRuntime: () => void
  onRejected: (message: string) => void
  messages: { upgrade: string; plugins: string; rejected: string; mismatch: string }
}

function supportedProjectRequest(
  data: ProjectEditingSave,
  context: ProjectEditingSaveContext,
  capabilities: ProjectEditingCapabilities
): ProjectEditingSave {
  const { project, deviceWorkspaces } = context.projectWork
  const roots = projectRoots(project)
  const originalRoots = roots.length
    ? roots
    : deviceWorkspaces.map(workspace => workspace.workspacePath)
  if (
    (!capabilities.multiRoots && !projectSettingEqual(originalRoots, data.roots)) ||
    (!capabilities.aiSettings &&
      data.aiSettings !== undefined &&
      !projectSettingEqual(
        normalizedProjectAi(project.aiSettings),
        normalizedProjectAi(data.aiSettings)
      )) ||
    (!capabilities.defaultProjectSpace &&
      data.defaultProjectSpace !== undefined &&
      !projectSettingEqual(project.defaultProjectSpace ?? null, data.defaultProjectSpace))
  )
    throw new Error(context.messages.upgrade)
  return {
    deviceId: data.deviceId,
    projectKey: data.projectKey,
    name: data.name.trim(),
    roots: data.roots,
    ...(capabilities.aiSettings && data.aiSettings !== undefined
      ? { aiSettings: data.aiSettings }
      : {}),
    ...(capabilities.defaultProjectSpace && data.defaultProjectSpace !== undefined
      ? { defaultProjectSpace: data.defaultProjectSpace }
      : {}),
  }
}

async function checkProjectPluginChanges(
  data: ProjectEditingSave,
  context: ProjectEditingSaveContext,
  capabilities: ProjectEditingCapabilities
): Promise<void> {
  if (
    data.aiSettings === undefined ||
    projectSettingEqual(
      normalizedProjectAi(context.projectWork.project.aiSettings).plugins,
      normalizedProjectAi(data.aiSettings).plugins
    )
  )
    return
  if (!capabilities.aiSettings || capabilities.plugins === 'unsupported')
    throw new Error(context.messages.plugins)
  if (capabilities.plugins === 'unknown') {
    if (!context.pluginApi?.checkSupport) throw new Error(context.messages.plugins)
    await context.pluginApi.checkSupport()
    context.ensureSameRuntime()
  }
}

function confirmedProjectUpdate(
  request: ProjectEditingSave,
  saved: RuntimeProjectWork,
  context: ProjectEditingSaveContext,
  capabilities: ProjectEditingCapabilities
): RuntimeProjectUpdate {
  const project = saved.project
  const roots =
    capabilities.multiRoots || project.roots
      ? projectRoots(project)
      : saved.deviceWorkspaces.map(workspace => workspace.workspacePath)
  verifyProjectEditingSave(
    request,
    {
      projectKey: getRuntimeProjectOwner(saved).projectKey,
      name: project.name,
      roots,
      aiSettings: project.aiSettings,
      defaultProjectSpace: project.defaultProjectSpace,
    },
    context.messages.mismatch
  )
  return {
    ...request,
    ...(context.projectWork.project.source === 'legacy_root' && project.source === 'local_project'
      ? { source: 'local_project' as const }
      : {}),
    roots,
    defaultProjectSpace: capabilities.defaultProjectSpace
      ? (project.defaultProjectSpace ?? null)
      : (context.projectWork.project.defaultProjectSpace ?? project.defaultProjectSpace ?? null),
    aiSettings: capabilities.aiSettings
      ? (project.aiSettings ?? null)
      : (context.projectWork.project.aiSettings ?? project.aiSettings ?? null),
  }
}

export async function saveProjectOnOwningRuntime(
  data: ProjectEditingSave,
  context: ProjectEditingSaveContext
): Promise<RuntimeProjectUpdate> {
  const capabilities = projectEditingCapabilities(context.device)
  const request = supportedProjectRequest(data, context, capabilities)
  await checkProjectPluginChanges(data, context, capabilities)
  context.ensureSameRuntime()
  const supportsUpsert =
    capabilities.multiRoots || capabilities.aiSettings || capabilities.defaultProjectSpace
  const response = supportsUpsert
    ? await context.runtime.upsertLocalRuntimeProject({ ...request, runtime: 'codex' })
    : await context.runtime.renameRuntimeWorkspace({
        deviceId: request.deviceId,
        projectKey: request.projectKey,
        workspacePath: request.roots[0],
        runtime: 'codex',
        name: request.name,
      })
  if (!response.accepted) {
    const message = response.error || context.messages.rejected
    context.onRejected(message)
    throw new Error(message)
  }
  context.ensureSameRuntime()
  if (
    (supportsUpsert || response.deviceId !== undefined) &&
    (!response.deviceId || !workbenchDeviceMatchesId(context.device, response.deviceId))
  )
    throw new Error(context.messages.mismatch)
  if (supportsUpsert)
    verifyProjectEditingSave(
      request,
      response as RuntimeLocalProjectUpsertResponse,
      context.messages.mismatch,
      true
    )
  const ownerWork = await context.runtime.listRuntimeWork({
    deviceId: data.deviceId,
    requireExplicitProjectRoots: capabilities.multiRoots,
  })
  context.ensureSameRuntime()
  const saved = findOwnedRuntimeProject(ownerWork, context.device, data.projectKey, context.devices)
  if (!saved) throw new Error(context.messages.mismatch)
  return confirmedProjectUpdate(request, saved, context, capabilities)
}

/** Validate the owning runtime's echo and readback before changing any mirror. */
export function verifyProjectEditingSave(
  expected: ProjectEditingSave,
  actual: Pick<
    RuntimeLocalProjectUpsertResponse,
    'projectKey' | 'name' | 'roots' | 'defaultProjectSpace' | 'aiSettings'
  >,
  mismatchMessage: string,
  requireRequestedFieldPresence = false
): void {
  if (
    (requireRequestedFieldPresence &&
      ((expected.aiSettings !== undefined && actual.aiSettings === undefined) ||
        (expected.defaultProjectSpace !== undefined &&
          actual.defaultProjectSpace === undefined))) ||
    actual.projectKey !== expected.projectKey ||
    actual.name !== expected.name ||
    !projectSettingEqual(actual.roots, expected.roots) ||
    (expected.defaultProjectSpace !== undefined &&
      !projectSettingEqual(actual.defaultProjectSpace ?? null, expected.defaultProjectSpace)) ||
    (expected.aiSettings !== undefined &&
      !projectSettingEqual(
        normalizedProjectAi(actual.aiSettings),
        normalizedProjectAi(expected.aiSettings)
      ))
  )
    throw new Error(mismatchMessage)
}
