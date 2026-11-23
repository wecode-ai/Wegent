import type { RemoteStandInRoleBranch } from '@/api/standIn'
import { standInState } from '@/features/notifications/standInNotifications'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import type { RuntimeTaskAddress } from '@/types/api'

type Status =
  | ReturnType<typeof standInState>['status']
  | 'waitingForDevice'
  | 'waitingForParent'
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
  'waitingForDependencies',
  'retrying',
  'blockedByDependency',
]
export const cancellingStatuses: Status[] = ['cancelling', 'cancellingWaitingForDevice']
export const activeStatuses: Status[] = [...actionableStatuses, ...cancellingStatuses]

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
  for (const row of remote) {
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
      status: remoteStatus[row.status],
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
      status:
        entry &&
        (entry.status === 'waitingForParent' ||
          entry.status === 'retrying' ||
          cancellingStatuses.includes(entry.status) ||
          (entry.status === 'cancelled' && actionableStatuses.includes(state.status)) ||
          (typeof origin.sourceDeviceId === 'string' &&
            state.status === 'completed' &&
            activeStatuses.includes(entry.status)))
          ? entry.status
          : state.status,
      error: state.summary,
      cancelGroup: entry?.cancelGroup,
      attempt: entry?.attempt ?? 0,
      retryAllowed: entry?.retryAllowed ?? false,
      dispatcherDeviceId:
        entry?.dispatcherDeviceId ??
        (typeof origin.sourceDeviceId === 'string' ? origin.sourceDeviceId : item.address.deviceId),
    })
  }
  return [...branches.values()]
}
