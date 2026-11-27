import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import type { RemoteStandInRoleBranch } from '@/api/standIn'
import { standInState } from '@/features/notifications/standInNotifications'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import type { RuntimeTaskAddress } from '@/types/api'

type Status =
  | ReturnType<typeof standInState>['status']
  | 'waitingForDevice'
  | 'waitingForParent'
  | 'waitingChildren'
  | 'waitingForDependencies'
  | 'retrying'
  | 'blockedByDependency'
  | 'cancelling'
  | 'cancellingWaitingForDevice'
export type Branch = {
  taskId: string
  address?: RuntimeTaskAddress | null
  title: string
  root: string
  createdAt: number
  ancestors: string[]
  prerequisiteTaskIds?: string[]
  parentId: string
  role?: string
  status: Status
  completionConfirmed?: boolean
  error?: string
  dispatcherDeviceId: string
  cancelGroup?: boolean
  attempt: number
  retryAllowed: boolean
}

const remoteStatus: Record<RemoteStandInRoleBranch['status'], Status> = {
  waiting_for_device: 'waitingForDevice',
  waiting_for_dependencies: 'waitingForDependencies',
  blocked_by_dependency: 'blockedByDependency',
  waiting_for_user: 'waiting',
  waiting_for_parent: 'waitingForParent',
  dispatched: 'running',
  retrying: 'retrying',
  running: 'running',
  done: 'completed',
  failed: 'failed',
  cancelling: 'cancelling',
  cancelling_waiting_for_device: 'cancellingWaitingForDevice',
  cancelled: 'cancelled',
}

export const actionableStatuses: Status[] = [
  'running',
  'waiting',
  'waitingForDevice',
  'waitingForParent',
  'waitingChildren',
  'waitingForDependencies',
  'retrying',
  'blockedByDependency',
]
export const cancellingStatuses: Status[] = ['cancelling', 'cancellingWaitingForDevice']
export const activeStatuses: Status[] = [...actionableStatuses, ...cancellingStatuses]

export function activeStandInAncestors(branches: Branch[]): ReadonlySet<string> {
  return new Set(
    branches.flatMap(branch => (activeStatuses.includes(branch.status) ? branch.ancestors : []))
  )
}

export function standInBranchStatus(branch: Branch, activeAncestors: ReadonlySet<string>) {
  return branch.status === 'completed' &&
    !branch.completionConfirmed &&
    activeAncestors.has(branch.taskId)
    ? 'waitingChildren'
    : branch.status
}

export function activeStandInBranchRows(branches: Branch[]) {
  const activeAncestors = activeStandInAncestors(branches)
  return branches.flatMap(branch => {
    const status = standInBranchStatus(branch, activeAncestors)
    return activeStatuses.includes(status)
      ? [{ taskId: branch.taskId, title: branch.title, address: branch.address, status }]
      : []
  })
}

export function selectStandInDelegatedWork(
  items: RuntimeTaskReminderItem[],
  remote: RemoteStandInRoleBranch[],
  userId: number,
  deviceId: string,
  taskId: string,
  aliases: ReadonlyMap<string, string>
): Branch[] {
  const sameDevice = (id: unknown) =>
    typeof id === 'string' && (aliases.get(id) ?? id) === (aliases.get(deviceId) ?? deviceId)
  const branches = new Map<string, Branch>()
  const localExecutionStatuses = new Set<string>()
  for (const row of remote) {
    if (row.statusSource === 'local_execution') localExecutionStatuses.add(row.taskId)
    branches.set(row.taskId, {
      taskId: row.taskId,
      address: row.taskAddress,
      title: row.title,
      root: row.root,
      createdAt: Date.parse(row.createdAt) || 0,
      ancestors: row.ancestors,
      prerequisiteTaskIds: row.prerequisiteTaskIds ?? undefined,
      parentId: row.parentTaskId,
      role: row.roleName,
      status:
        row.status === 'running' && row.waitingForChildren
          ? 'waitingChildren'
          : remoteStatus[row.status],
      completionConfirmed: row.status === 'done',
      dispatcherDeviceId: deviceId,
      cancelGroup: row.cancelGroup,
      attempt: row.attempt,
      retryAllowed: row.retryAllowed,
    })
  }
  for (const item of items) {
    const origin = item.task.runtimeHandle?.origin as Record<string, unknown> | undefined
    if (origin?.type !== 'stand_in_task' || origin.userId !== userId) continue
    const branch = origin.roleDelegation as
      | { root?: unknown; ancestors?: unknown; rootDevice?: unknown }
      | undefined
    if (
      typeof branch?.root !== 'string' ||
      !Array.isArray(branch.ancestors) ||
      branch.ancestors[0] !== taskId ||
      typeof origin.sourceTaskId !== 'string' ||
      !sameDevice(branch.rootDevice ?? origin.deviceId)
    ) {
      continue
    }
    const state = standInState(item)
    const entry = branches.get(item.address.taskId)
    const execution = (item.lifecycle?.task?.runtimeHandle?.executionRequest ??
      item.task.runtimeHandle?.executionRequest) as
      | { standInDelegation?: { attempt?: unknown } }
      | undefined
    const nativeAttempt = execution?.standInDelegation?.attempt
    const attempt =
      typeof nativeAttempt === 'number' && Number.isSafeInteger(nativeAttempt) && nativeAttempt >= 0
        ? nativeAttempt
        : 0
    const newerAttempt = Boolean(entry && attempt > entry.attempt)
    // The dispatcher owns terminal results and operation states. A live task
    // from an older attempt cannot overwrite them.
    const useDispatcherStatus =
      entry &&
      !newerAttempt &&
      (entry.attempt > attempt ||
        localExecutionStatuses.has(entry.taskId) ||
        (entry.status !== 'running' && entry.status !== 'waiting') ||
        (typeof origin.sourceDeviceId === 'string' && state.status === 'completed'))
    branches.set(item.address.taskId, {
      taskId: item.address.taskId,
      address: item.address,
      title: item.task.title,
      root: branch.root,
      createdAt: entry?.createdAt ?? (new Date(item.task.createdAt ?? 0).getTime() || 0),
      ancestors: branch.ancestors,
      prerequisiteTaskIds: entry?.prerequisiteTaskIds,
      parentId: origin.sourceTaskId,
      role: typeof origin.standInName === 'string' ? origin.standInName : entry?.role,
      status: useDispatcherStatus ? entry.status : state.status,
      completionConfirmed: useDispatcherStatus ? entry.completionConfirmed : undefined,
      error: state.summary,
      cancelGroup: entry?.cancelGroup,
      attempt: Math.max(entry?.attempt ?? 0, attempt),
      retryAllowed: !newerAttempt && (entry?.retryAllowed ?? false),
      dispatcherDeviceId:
        entry?.dispatcherDeviceId ??
        (typeof origin.sourceDeviceId === 'string' ? origin.sourceDeviceId : item.address.deviceId),
    })
  }
  return [...branches.values()]
}

type DelegationGroup = { root: string; createdAt: number; branches: Branch[] }

export function groupStandInDelegations(branches: Branch[]) {
  const groups = new Map<string, DelegationGroup>()
  const orderedBranches = branches.toSorted((left, right) => left.createdAt - right.createdAt)
  for (const branch of orderedBranches) {
    const group = groups.get(branch.root)
    if (group) group.branches.push(branch)
    else {
      groups.set(branch.root, {
        root: branch.root,
        createdAt: branch.createdAt,
        branches: [branch],
      })
    }
  }
  return [...groups.values()]
}

/** Delegations are dated by the dispatcher. Keep them next to the preceding visible request. */
export function standInDelegationsByMessage(
  messages: Pick<WorkbenchMessage, 'id' | 'role' | 'source' | 'createdAt'>[],
  groups: DelegationGroup[]
) {
  const requests = messages
    .filter(message => message.role === 'user' && message.source?.source !== 'stand_in_activity')
    .map(message => ({ id: message.id, createdAt: Date.parse(message.createdAt) }))
    .filter(message => Number.isFinite(message.createdAt))
    .sort((left, right) => left.createdAt - right.createdAt)
  const byMessage = new Map<string, DelegationGroup[]>()
  let index = -1
  for (const group of groups) {
    while (requests[index + 1]?.createdAt <= group.createdAt) index++
    const request = requests[index]
    if (!request) continue
    const existing = byMessage.get(request.id)
    if (existing) existing.push(group)
    else byMessage.set(request.id, [group])
  }
  return byMessage
}
