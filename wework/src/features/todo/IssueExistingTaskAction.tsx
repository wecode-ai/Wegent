import { useMemo, useState } from 'react'
import type { WeworkWorkspaceRuntimePort } from '@wegent/collaboration'
import type { CloudLoopItem, LoopItemTaskBinding } from '@/api/deliveries'
import { getRuntimeTaskActivityTime } from '@/components/layout/runtimeTaskSidebarHelpers'
import type { RuntimeProjectSpaceRef, RuntimeWorkListResponse } from '@/types/api'
import { toWorkspaceRuntimeTaskAddress } from '@/features/workbench/projectTaskTracking'
import { publishProjectSpaceTaskBindingChanged } from './projectSpaceSelection'
import { IssueExistingTaskPicker, type ExistingIssueTask } from './IssueExistingTaskPicker'

export interface ExistingIssueTaskSource {
  work?: RuntimeWorkListResponse | null
  port: Pick<WeworkWorkspaceRuntimePort, 'bindTask' | 'unbindTask'>
  onLinked?: () => void
}

function collectExistingIssueTasks(
  work: ExistingIssueTaskSource['work'],
  bindings: readonly LoopItemTaskBinding[] | undefined,
  linked: ReadonlySet<string>
): ExistingIssueTask[] {
  const existing = new Set(bindings?.map(binding => `${binding.device_id}:${binding.task_id}`))
  const tasks = new Map<string, ExistingIssueTask & { activityTime: number }>()
  for (const workspace of [
    ...(work?.projects ?? []).flatMap(entry => entry.deviceWorkspaces),
    ...(work?.chats ?? []),
  ]) {
    for (const task of workspace.tasks) {
      const key = `${workspace.deviceId}:${task.taskId}`
      if (existing.has(key) || linked.has(key)) continue
      tasks.set(key, {
        activityTime: getRuntimeTaskActivityTime(task),
        title: task.title,
        address: {
          deviceId: workspace.deviceId,
          taskId: task.taskId,
          runtime: task.runtime,
          threadId: task.threadId,
          workspacePath: task.workspacePath || workspace.workspacePath,
          runtimeHandle: task.runtimeHandle,
        },
      })
    }
  }
  return [...tasks.values()].sort((left, right) => right.activityTime - left.activityTime)
}

/** All desktop Issue surfaces share task discovery, binding and refresh semantics. */
export function IssueExistingTaskAction({
  source,
  issue,
  project,
  bindings,
  deviceNamesById,
  onLinked,
}: {
  source: ExistingIssueTaskSource
  issue: CloudLoopItem
  project: RuntimeProjectSpaceRef
  bindings?: readonly LoopItemTaskBinding[]
  deviceNamesById?: Readonly<Record<string, string>>
  onLinked: () => void
}) {
  const [linked, setLinked] = useState<Set<string>>(new Set())
  const { work } = source
  const tasks = useMemo(
    () => collectExistingIssueTasks(work, bindings, linked),
    [work, bindings, linked]
  )
  return (
    <IssueExistingTaskPicker
      tasks={tasks}
      deviceNamesById={deviceNamesById}
      onSelect={async task => {
        await source.port.bindTask(
          issue.id,
          toWorkspaceRuntimeTaskAddress(task.address),
          task.title,
          null
        )
        setLinked(
          current => new Set([...current, `${task.address.deviceId}:${task.address.taskId}`])
        )
        publishProjectSpaceTaskBindingChanged({
          task: task.address,
          project,
          type: 'bound',
        })
        onLinked()
        source.onLinked?.()
      }}
    />
  )
}
