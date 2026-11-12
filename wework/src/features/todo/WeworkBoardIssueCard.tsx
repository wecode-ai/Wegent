import type { ComponentProps } from 'react'
import {
  CollaborationApp,
  collaborationTestIds,
  type WorkspaceTaskBinding,
} from '@wegent/collaboration'
import { findRuntimeTask } from '@wegent/chat-core/runtime-task-lookup'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'
import { runtimeConversationKey } from '@/features/workbench/runtimeConversationCache'
import { CloudTodoBoardCard, type CloudTodoBoardTaskBinding } from './CloudTodoBoardCard'

type CardProps = ComponentProps<typeof CloudTodoBoardCard>
export type WeworkBoardIssueCardContext = Parameters<
  NonNullable<ComponentProps<typeof CollaborationApp>['renderBoardIssueCard']>
>[0]

/** Both group and project boards render only the caller-owned bindings supplied by their API. */
export function WeworkBoardIssueCard({
  context,
  projectStore,
  runtimeWork,
  runningByAddress,
  resolveAddress,
  getRuntimeTranscript,
  onOpenRuntimeTask,
  renderBadges,
}: {
  context: WeworkBoardIssueCardContext
  projectStore: CloudProject['project_store']
  runtimeWork?: RuntimeWorkListResponse | null
  runningByAddress?: ReadonlyMap<string, boolean>
  resolveAddress(binding: WorkspaceTaskBinding): RuntimeTaskAddress
  getRuntimeTranscript?: CardProps['getRuntimeTranscript']
  onOpenRuntimeTask?: CardProps['onOpenRuntimeTask']
  renderBadges?: CardProps['renderBadges']
}) {
  const { t } = useTranslation('common')
  const { issue, metadata, childrenAction, display, focused, onOpen, onDelete, onMarkRead } =
    context
  const bindings: CloudTodoBoardTaskBinding[] = context.taskBindings.map(binding => {
    const task = findRuntimeTask(runtimeWork, {
      deviceId: binding.deviceId,
      taskId: binding.taskId,
    })
    return {
      id: binding.id,
      device_id: binding.deviceId,
      task_id: binding.taskId,
      task_title: binding.taskTitle,
      running:
        runningByAddress?.get(
          runtimeConversationKey({ deviceId: binding.deviceId, taskId: binding.taskId })
        ) ??
        task?.running ??
        false,
      modelSelection: binding.modelSelection,
      executionContext: binding.executionContext,
      runtimeAddress: resolveAddress(binding),
      runtimeTask: task,
    } as CloudTodoBoardTaskBinding
  })
  return (
    <div className="w-full" data-testid={collaborationTestIds.issue(issue.id)}>
      <CloudTodoBoardCard
        metadata={metadata}
        childrenAction={childrenAction}
        item={{ ...issue, project_store: projectStore } as unknown as CloudLoopItem}
        taskBindings={bindings}
        getRuntimeTranscript={getRuntimeTranscript}
        unread={false}
        onClick={onOpen}
        onArchive={onDelete ?? (() => undefined)}
        archiveLabel={t('todo.archive_issue', '归档任务')}
        onMarkRead={onMarkRead}
        issueDetailOnly
        onOpenRuntimeTask={onOpenRuntimeTask}
        display={display}
        archiveDisabled={!onDelete}
        progressDisplay={focused ? 'focused' : 'compact'}
        renderBadges={renderBadges}
      />
    </div>
  )
}
