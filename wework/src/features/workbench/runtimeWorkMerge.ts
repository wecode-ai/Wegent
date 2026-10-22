import type {
  DeviceInfo,
  RuntimeDeviceWorkspace,
  RuntimeProjectWork,
  RuntimeTaskSummary,
  RuntimeWorkListResponse,
} from '@/types/api'
import {
  getRuntimeProjectReference,
  isRuntimeDirectoryProject,
  runtimeProjectTargetKey,
  runtimeWorkspaceLocationKey,
} from '@/lib/runtime-project-identity'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import {
  getLocalRuntimeSourceIdentity,
  qualifyLocalRuntimeSource,
} from '@/lib/local-runtime-sidebar-identity'
import { createWorkbenchDeviceResolver, type WorkbenchDeviceResolver } from '@/lib/workbench-device'
import {
  normalizeRuntimeTaskSummary,
  shouldReplaceRuntimeTaskProjection,
} from './runtimeTaskLifecycle/projection'

interface RuntimeWorkMergeContext {
  devices?: DeviceInfo[]
}

export function mergeRuntimeWorkLists(
  primaryWork: RuntimeWorkListResponse,
  secondaryWork: RuntimeWorkListResponse,
  context: RuntimeWorkMergeContext = {}
): RuntimeWorkListResponse {
  const canonicalizer = createWorkbenchDeviceResolver(context.devices ?? [])
  const mergedProjects = mergeRuntimeProjects(
    primaryWork.projects,
    secondaryWork.projects,
    canonicalizer
  )
  const mergedChats = mergeRuntimeWorkspaces(primaryWork.chats, secondaryWork.chats, canonicalizer)
  const { projects, chats } = dedupeRuntimeTaskProjections(mergedProjects, mergedChats)
  const totalTasks =
    projects.reduce((total, project) => total + countWorkspaceTasks(project.deviceWorkspaces), 0) +
    countWorkspaceTasks(chats)

  return {
    projects,
    chats,
    totalTasks,
  }
}

interface ProjectEntry {
  work: RuntimeProjectWork
  index: number
}

interface ProjectGroup {
  native: ProjectEntry[]
  references: ProjectEntry[]
}

function mergeRuntimeProjects(
  primaryProjects: RuntimeProjectWork[],
  secondaryProjects: RuntimeProjectWork[],
  devices: WorkbenchDeviceResolver
): RuntimeProjectWork[] {
  const entries = [...primaryProjects, ...secondaryProjects].map((work, index) => ({
    index,
    work: { ...work, deviceWorkspaces: mergeRuntimeWorkspaces([], work.deviceWorkspaces, devices) },
  }))
  const groups = new Map<string, ProjectGroup>()
  const references: ProjectEntry[] = []
  for (const entry of entries) {
    if (getRuntimeProjectReference(entry.work)) {
      references.push(entry)
      continue
    }
    const key = nativeProjectIdentity(entry.work, devices)
    const group = groups.get(key) ?? { native: [], references: [] }
    group.native.push(entry)
    groups.set(key, group)
  }

  // A directory listing may describe a named project's root, but two named
  // projects never become identical merely because they share that root.
  const namedLocations = indexProjectLocations(
    [...groups.values()].filter(group =>
      group.native.some(entry => !isRuntimeDirectoryProject(entry.work))
    ),
    devices
  )
  for (const [key, group] of groups) {
    if (!group.native.every(entry => isRuntimeDirectoryProject(entry.work))) continue
    const target = uniqueLocationGroup(group.native, namedLocations, devices)
    if (!target) continue
    target.native.push(...group.native)
    groups.delete(key)
  }

  const locations = indexProjectLocations([...groups.values()], devices)
  const targets = new Map<string, Set<ProjectGroup>>()
  for (const group of groups.values()) {
    for (const { work } of group.native) {
      if (!work.project.key) continue
      const owner = work.project.stateDeviceId ?? work.deviceWorkspaces[0]?.deviceId ?? ''
      addGroupIndex(
        targets,
        runtimeProjectTargetKey(
          owner,
          work.project.key,
          devices,
          getLocalRuntimeSourceIdentity(work.project)
        ),
        group
      )
    }
  }
  for (const entry of references) {
    const reference = getRuntimeProjectReference(entry.work)!
    const targetKey = reference.projectKey
      ? runtimeProjectTargetKey(reference.hostId, reference.projectKey, devices)
      : null
    const matching = targetKey
      ? targets.get(targetKey)
      : locations.get(
          runtimeWorkspaceLocationKey(
            { deviceId: reference.hostId, workspacePath: reference.workspacePath },
            devices
          )
        )
    const target = matching?.size === 1 ? [...matching][0] : null
    const key = targetKey
      ? `target:${targetKey}`
      : `reference:${runtimeProjectTargetKey(reference.stateDeviceId ?? '', reference.stateKey, devices, getLocalRuntimeSourceIdentity(entry.work.project))}`
    const group = target ?? groups.get(key) ?? { native: [], references: [] }
    group.references.push(entry)
    if (!target) groups.set(key, group)
  }

  return [...groups.values()]
    .map(group => ({
      work: mergeProjectGroup(group, devices),
      index: Math.min(
        ...(group.references.length ? group.references : group.native).map(entry => entry.index)
      ),
    }))
    .sort((left, right) => {
      const leftOrder = left.work.project.sidebarOrder
      const rightOrder = right.work.project.sidebarOrder
      if (leftOrder != null && rightOrder != null && leftOrder !== rightOrder)
        return leftOrder - rightOrder
      if (leftOrder != null && rightOrder == null) return -1
      if (leftOrder == null && rightOrder != null) return 1
      return left.index - right.index
    })
    .map(entry => entry.work)
}

function nativeProjectIdentity(work: RuntimeProjectWork, devices: WorkbenchDeviceResolver): string {
  // Backend project ids are global; executor project keys are owner-scoped.
  if (
    !work.project.source &&
    work.project.id != null &&
    work.deviceWorkspaces.every(workspace => workspace.projectId === work.project.id)
  ) {
    return `backend:${work.project.id}`
  }
  const workspace = work.deviceWorkspaces[0]
  if (workspace && isRuntimeDirectoryProject(work)) {
    return `directory:${runtimeWorkspaceLocationKey(workspace, devices)}`
  }
  const owner = work.project.stateDeviceId ?? workspace?.deviceId ?? ''
  return `project:${runtimeProjectTargetKey(owner, work.project.key, devices, getLocalRuntimeSourceIdentity(work.project))}`
}

function addGroupIndex(index: Map<string, Set<ProjectGroup>>, key: string, group: ProjectGroup) {
  const groups = index.get(key) ?? new Set<ProjectGroup>()
  groups.add(group)
  index.set(key, groups)
}

function indexProjectLocations(groups: ProjectGroup[], devices: WorkbenchDeviceResolver) {
  const index = new Map<string, Set<ProjectGroup>>()
  for (const group of groups) {
    for (const { work } of group.native) {
      for (const workspace of work.deviceWorkspaces) {
        addGroupIndex(index, runtimeWorkspaceLocationKey(workspace, devices), group)
      }
    }
  }
  return index
}

function uniqueLocationGroup(
  entries: ProjectEntry[],
  index: Map<string, Set<ProjectGroup>>,
  devices: WorkbenchDeviceResolver
): ProjectGroup | null {
  const matches = new Set(
    entries.flatMap(({ work }) =>
      work.deviceWorkspaces.flatMap(workspace => [
        ...(index.get(runtimeWorkspaceLocationKey(workspace, devices)) ?? []),
      ])
    )
  )
  return matches.size === 1 ? [...matches][0] : null
}

function mergeProjectGroup(
  group: ProjectGroup,
  devices: WorkbenchDeviceResolver
): RuntimeProjectWork {
  const native = [...group.native].sort(
    (left, right) =>
      Number(isRuntimeDirectoryProject(left.work)) -
        Number(isRuntimeDirectoryProject(right.work)) || left.index - right.index
  )
  const descriptor = group.references[0]?.work
  const inputs = native.length ? native : group.references
  const first = inputs[0].work
  let project = first.project
  let deviceWorkspaces: RuntimeDeviceWorkspace[] = []
  for (const { work } of inputs) {
    project = { ...work.project, ...project, id: project.id ?? work.project.id }
    deviceWorkspaces = mergeRuntimeWorkspaces(deviceWorkspaces, work.deviceWorkspaces, devices)
  }
  if (descriptor) {
    const reference = getRuntimeProjectReference(descriptor)!
    const ownerProjectKey = reference.projectKey ?? (native.length ? first.project.key : null)
    project = {
      ...project,
      id: descriptor.project.id ?? project.id ?? runtimeProjectUiId(project),
      ...(ownerProjectKey
        ? {
            ownerDeviceId:
              descriptor.project.ownerDeviceId ?? first.project.ownerDeviceId ?? reference.hostId,
            ownerProjectKey,
          }
        : {}),
      sidebarStateKey: reference.stateKey,
      stateDeviceId: reference.stateDeviceId,
      kind: 'remote',
      source: 'remote_project',
      name: descriptor.project.name,
      sidebarOrder: descriptor.project.sidebarOrder,
      pinned: descriptor.project.pinned,
      pinnedOrder: descriptor.project.pinnedOrder,
      active: descriptor.project.active,
      appearance: descriptor.project.appearance,
    }
    const localSource = getLocalRuntimeSourceIdentity(descriptor.project)
    if (localSource) project = qualifyLocalRuntimeSource(project, localSource)
    deviceWorkspaces = deviceWorkspaces.map(workspace => ({
      ...workspace,
      workspaceSource: 'remote',
      remoteHostId:
        devices.identityKey(workspace.deviceId) === devices.identityKey(reference.hostId)
          ? reference.hostId
          : (workspace.remoteHostId ?? workspace.deviceId),
    }))
  }
  return { project, deviceWorkspaces, totalTasks: countWorkspaceTasks(deviceWorkspaces) }
}

function mergeRuntimeWorkspaces(
  primaryWorkspaces: RuntimeDeviceWorkspace[],
  secondaryWorkspaces: RuntimeDeviceWorkspace[],
  canonicalizer: WorkbenchDeviceResolver
): RuntimeDeviceWorkspace[] {
  const workspaces = new Map<
    string,
    { workspace: RuntimeDeviceWorkspace; inputTaskCount: number }
  >()
  const workspaceRouteAliases = new Map<string, string>()

  const upsertWorkspace = (workspace: RuntimeDeviceWorkspace) => {
    const canonicalWorkspace = canonicalizeRuntimeWorkspace(workspace, canonicalizer)
    const routeIdentity = runtimeWorkspaceLocationKey(canonicalWorkspace, canonicalizer)
    const mappingIdentity =
      canonicalWorkspace.id != null && canonicalWorkspace.projectId != null
        ? `mapping:${canonicalWorkspace.projectId}:${canonicalWorkspace.id}`
        : routeIdentity
    const key = workspaceRouteAliases.get(routeIdentity) ?? mappingIdentity
    const existingEntry = workspaces.get(key)
    const existing = existingEntry?.workspace
    const tasks = mergeRuntimeTasks(existing?.tasks ?? [], canonicalWorkspace.tasks)
    workspaces.set(key, {
      workspace: {
        ...canonicalWorkspace,
        ...(existing ?? {}),
        deviceName:
          existing?.workspaceSource === 'remote' && canonicalWorkspace.workspaceSource === 'remote'
            ? (canonicalWorkspace.deviceName ?? existing.deviceName)
            : (existing?.deviceName ?? canonicalWorkspace.deviceName),
        available: (existing?.available ?? false) || canonicalWorkspace.available,
        tasks,
      },
      inputTaskCount: (existingEntry?.inputTaskCount ?? 0) + canonicalWorkspace.tasks.length,
    })
    workspaceRouteAliases.set(routeIdentity, key)
  }

  primaryWorkspaces.forEach(upsertWorkspace)
  secondaryWorkspaces.forEach(upsertWorkspace)

  return Array.from(workspaces.values())
    .filter(entry => shouldKeepRuntimeWorkspace(entry.workspace, entry.inputTaskCount))
    .map(entry => entry.workspace)
}

function shouldKeepRuntimeWorkspace(
  workspace: RuntimeDeviceWorkspace,
  inputTaskCount: number
): boolean {
  if (workspace.tasks.length > 0) return true
  if (inputTaskCount > 0) return false
  return workspace.mapped === true || workspace.projectId != null || workspace.id != null
}

function canonicalizeRuntimeWorkspace(
  workspace: RuntimeDeviceWorkspace,
  canonicalizer: WorkbenchDeviceResolver
): RuntimeDeviceWorkspace {
  const localSource = getLocalRuntimeSourceIdentity(workspace)
  const device = canonicalizer.resolve(
    localSource?.deviceId === workspace.deviceId
      ? localSource.runtimeInstanceId
      : workspace.deviceId
  )
  if (!device) return workspace
  return {
    ...workspace,
    deviceId: device.device_id,
    deviceName: device.name ?? workspace.deviceName,
    deviceStatus: device.status ?? workspace.deviceStatus,
    available: workspace.available || isRuntimeWorkspaceDeviceAvailable(device),
  }
}

function isRuntimeWorkspaceDeviceAvailable(device: DeviceInfo): boolean {
  return device.status === 'online' || device.status === 'busy'
}

function mergeRuntimeTasks(
  primaryTasks: RuntimeTaskSummary[],
  secondaryTasks: RuntimeTaskSummary[]
): RuntimeTaskSummary[] {
  const tasks = new Map<string, RuntimeTaskSummary>()

  const upsertTask = (task: RuntimeTaskSummary) => {
    const candidate = normalizeRuntimeTaskSummary(task)
    const current = tasks.get(candidate.taskId)
    if (!current || shouldReplaceRuntimeTaskProjection(current, candidate)) {
      tasks.set(candidate.taskId, candidate)
    }
  }

  primaryTasks.forEach(upsertTask)
  secondaryTasks.forEach(upsertTask)

  return Array.from(tasks.values())
}

interface RuntimeTaskProjection {
  workspace: RuntimeDeviceWorkspace
  task: RuntimeTaskSummary
  aliases: Set<string>
}

function dedupeRuntimeTaskProjections(
  projects: RuntimeProjectWork[],
  chats: RuntimeDeviceWorkspace[]
): Pick<RuntimeWorkListResponse, 'projects' | 'chats'> {
  const winners = new Set<RuntimeTaskProjection>()
  const winnersByAlias = new Map<string, RuntimeTaskProjection>()
  const workspaces = [...projects.flatMap(project => project.deviceWorkspaces), ...chats]

  workspaces.forEach(workspace => {
    workspace.tasks.forEach(task => {
      const aliases = runtimeTaskProjectionAliases(workspace, task)
      const matches = new Set(
        [...aliases]
          .map(alias => winnersByAlias.get(alias))
          .filter((projection): projection is RuntimeTaskProjection => Boolean(projection))
      )
      const candidate = { workspace, task, aliases }
      const winner = [...matches, candidate].reduce((current, projection) =>
        shouldReplaceRuntimeTaskProjection(current.task, projection.task) ? projection : current
      )
      const mergedAliases = new Set([
        ...aliases,
        ...[...matches].flatMap(projection => [...projection.aliases]),
      ])

      matches.forEach(projection => winners.delete(projection))
      winner.aliases = mergedAliases
      winners.add(winner)
      mergedAliases.forEach(alias => winnersByAlias.set(alias, winner))
    })
  })

  const winningTasks = new Set([...winners].map(projection => projection.task))
  const retainWinningTasks = (workspace: RuntimeDeviceWorkspace): RuntimeDeviceWorkspace | null => {
    const inputTaskCount = workspace.tasks.length
    const tasks = workspace.tasks.filter(task => winningTasks.has(task))
    const filteredWorkspace = tasks.length === inputTaskCount ? workspace : { ...workspace, tasks }
    return shouldKeepRuntimeWorkspace(filteredWorkspace, inputTaskCount) ? filteredWorkspace : null
  }
  const dedupedProjects = projects
    .map(project => {
      const deviceWorkspaces = project.deviceWorkspaces.flatMap(workspace => {
        const retained = retainWinningTasks(workspace)
        return retained ? [retained] : []
      })
      return {
        ...project,
        deviceWorkspaces,
        totalTasks: countWorkspaceTasks(deviceWorkspaces),
      }
    })
    .filter(project => project.deviceWorkspaces.length > 0)
  const dedupedChats = chats.flatMap(workspace => {
    const retained = retainWinningTasks(workspace)
    return retained ? [retained] : []
  })

  return {
    projects: dedupedProjects,
    chats: dedupedChats,
  }
}

function runtimeTaskProjectionAliases(
  workspace: RuntimeDeviceWorkspace,
  task: RuntimeTaskSummary
): Set<string> {
  return new Set([`${task.taskId}\0device:${workspace.deviceId}`])
}

function countWorkspaceTasks(workspaces: RuntimeDeviceWorkspace[]): number {
  return workspaces.reduce((total, workspace) => total + workspace.tasks.length, 0)
}
