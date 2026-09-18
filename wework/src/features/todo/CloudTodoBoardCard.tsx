import { runtimeTaskProgress, runtimeToolActivityText } from '@wegent/collaboration'
import {
  IssueBoardCard,
  IssueBoardCardContent,
  IssueCardTaskSummary,
  getCurrentWorkflowNode,
  createIssueBoardCardLabels,
  createCollaborationTranslator,
} from '@wegent/collaboration'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { CloudLoopItem } from '@/api/deliveries'
import { canEditProjectSpaceIssue } from './projectSpaceSelection'
import type { TaskChangeRequestSnapshot, TaskChangeRequestTarget } from '@/api/changeRequests'
import { DshContributionSlotSurface } from '@/features/dsh-runtime/DshContributionSlotSurface'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { TemporaryChatPanel } from '@/components/layout/workspace-panels/TemporaryChatPanel'
import {
  getRuntimeConversationTurns,
  subscribeRuntimeConversation,
} from '@/features/workbench/runtimeConversationCache'
import type { RuntimeLiveActivity } from '@/features/workbench/runtimeThinking'
import { useTranslation } from '@/hooks/useTranslation'
import type { ModelSelectionConfig, RuntimeGoal, RuntimeTaskAddress } from '@/types/api'
import type { RuntimeConversationTurn } from '@/types/workbench'
import type { ChangeRequestMonitor } from '@/features/workbench/changeRequestMonitor'
import { useTaskChangeRequest } from '@/features/workbench/changeRequestMonitor'
import {
  autoRepairStatus,
  stoppedTaskNeedsAttention,
} from '@/features/workbench/changeRequestStatus'
import { isLoopItemExecutionActive } from './cloudMyWorkModel'
import { itemNeedsExecutionConfiguration } from './workflowExecutionConfig'

export interface BoardCardDisplaySettings {
  showAssignee: boolean
  showPriority: boolean
  showReference?: boolean
  showTags: boolean
  showDate: boolean
}

export type BoardCardProgressDisplay = 'compact' | 'focused'

const EMPTY_RUNTIME_CONVERSATION_TURNS: RuntimeConversationTurn[] = []

function useBoardTranslate() {
  const { i18n } = useTranslation('common')
  return createCollaborationTranslator(i18n.language.startsWith('zh') ? 'zh-CN' : 'en')
}

interface CloudTodoCardContentProps {
  item: CloudLoopItem
  goalBinding?: CloudTodoBoardTaskBinding
  display: BoardCardDisplaySettings
  processingStatus: boolean
  showWorkflowStage?: boolean
  /** Active robot names for the current project, used when the item only
   * carries `assignee_agent_id` (local projects do not resolve the name). */
  agentNames?: Record<string, string>
}

export function CloudTodoCardContent({
  item,
  goalBinding,
  display,
  processingStatus,
  showWorkflowStage = true,
  agentNames,
}: CloudTodoCardContentProps) {
  const t = useBoardTranslate()
  return (
    <IssueBoardCardContent
      item={item}
      reference={item.id}
      display={display}
      labels={createIssueBoardCardLabels(t)}
      agentNames={agentNames}
      translate={t}
      goal={
        goalBinding?.runtimeGoal
          ? { bindingId: goalBinding.id, objective: goalBinding.runtimeGoal.objective }
          : null
      }
      needsExecutionConfiguration={processingStatus && itemNeedsExecutionConfiguration(item)}
      workflowNode={
        showWorkflowStage && item.workflow ? getCurrentWorkflowNode(item.workflow.nodes) : null
      }
    />
  )
}

export interface CloudTodoBoardTaskBinding {
  id: string | number
  device_id: string
  task_id: string
  task_title: string | null
  workflow_node_id?: string | null
  running: boolean
  changeRequestTarget?: TaskChangeRequestTarget | null
  modelSelection?: ModelSelectionConfig | null
  runtimeGoal?: RuntimeGoal | null
  runtimeGoalLoaded?: boolean
}

interface CloudTodoBoardCardProps {
  item: CloudLoopItem
  unread?: boolean
  taskBindings?: CloudTodoBoardTaskBinding[]
  onClick: () => void
  onConfigureExecution?: () => void
  onArchive: () => void
  previewPinned?: boolean
  onPreviewPinnedChange?: (pinned: boolean) => void
  onMarkRead?: (item: CloudLoopItem) => void
  onLoadRuntimeGoal?: (address: RuntimeTaskAddress) => Promise<void>
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  display: BoardCardDisplaySettings
  processingStatus: boolean
  agentNames?: Record<string, string>
  dragDisabled?: boolean
  previewDisabled?: boolean
  archiveDisabled?: boolean
  /** Menu label for the archive action; defaults to the archive wording. */
  archiveLabel?: string
  progressDisplay?: BoardCardProgressDisplay
  changeRequestMonitor?: ChangeRequestMonitor | null
  onContinueChangeRequestRepair?: (
    binding: CloudTodoBoardTaskBinding,
    snapshot: TaskChangeRequestSnapshot
  ) => Promise<void>
}

export function CloudTodoBoardCard({
  item,
  unread,
  taskBindings = [],
  onClick,
  onConfigureExecution,
  onArchive,
  previewPinned,
  onPreviewPinnedChange,
  onMarkRead,
  onLoadRuntimeGoal,
  onOpenRuntimeTask,
  display,
  processingStatus,
  agentNames,
  dragDisabled = false,
  previewDisabled = false,
  archiveDisabled = false,
  archiveLabel,
  progressDisplay = 'compact',
  changeRequestMonitor = null,
  onContinueChangeRequestRepair,
}: CloudTodoBoardCardProps) {
  const t = useBoardTranslate()
  const editable = canEditProjectSpaceIssue(item)
  const currentWorkflowNode = item.workflow ? getCurrentWorkflowNode(item.workflow.nodes) : null
  const needsExecutionConfiguration =
    processingStatus && itemNeedsExecutionConfiguration(item) && Boolean(onConfigureExecution)
  const hasActiveTask = isLoopItemExecutionActive(item)
  const runningTaskBindings = taskBindings.filter(binding => binding.running)
  const currentTaskBinding = runningTaskBindings[0] ?? taskBindings[0]
  const changeRequestSnapshot = useTaskChangeRequest(
    changeRequestMonitor,
    currentTaskBinding?.changeRequestTarget ?? null
  )
  const showCurrentTask = Boolean(
    currentTaskBinding &&
    (currentTaskBinding.running ||
      hasActiveTask ||
      item.status === 'in_review' ||
      stoppedTaskNeedsAttention(changeRequestSnapshot?.changeRequest ?? null))
  )
  const [repairingChangeRequest, setRepairingChangeRequest] = useState(false)
  const progressTaskBindings =
    runningTaskBindings.length > 0
      ? runningTaskBindings
      : showCurrentTask && currentTaskBinding
        ? [currentTaskBinding]
        : []
  return (
    <IssueBoardCard
      item={item}
      unread={unread}
      reference={item.id}
      display={display}
      labels={createIssueBoardCardLabels(t)}
      agentNames={agentNames}
      translate={t}
      workflowNode={currentWorkflowNode}
      needsExecutionConfiguration={needsExecutionConfiguration}
      onConfigureExecution={onConfigureExecution}
      archiveLabel={archiveLabel}
      onArchive={editable && !archiveDisabled ? onArchive : undefined}
      previewPinned={previewPinned}
      onPreviewPinnedChange={onPreviewPinnedChange}
      previewDisabled={previewDisabled}
      onMarkRead={onMarkRead ? () => onMarkRead(item) : undefined}
      progressTaskBindings={progressTaskBindings}
      goal={
        currentTaskBinding?.runtimeGoal
          ? {
              bindingId: currentTaskBinding.id,
              objective: currentTaskBinding.runtimeGoal.objective,
            }
          : null
      }
      dragEnabled={editable && !dragDisabled}
      onOpen={onClick}
      renderTaskSummary={(binding, compact) => (
        <RuntimeTaskProgressSummary
          key={binding.id}
          item={item}
          binding={binding}
          compact={compact}
          progressDisplay={progressDisplay}
          active={binding.running || (binding.id === currentTaskBinding?.id && hasActiveTask)}
          changeRequestSnapshot={
            compact && binding.id === currentTaskBinding?.id ? changeRequestSnapshot : null
          }
          repairingChangeRequest={compact && repairingChangeRequest}
          onContinueChangeRequestRepair={
            compact &&
            binding.id === currentTaskBinding?.id &&
            changeRequestSnapshot?.changeRequest &&
            autoRepairStatus(changeRequestSnapshot.changeRequest) &&
            onContinueChangeRequestRepair
              ? async () => {
                  setRepairingChangeRequest(true)
                  try {
                    await onContinueChangeRequestRepair(binding, changeRequestSnapshot)
                  } finally {
                    setRepairingChangeRequest(false)
                  }
                }
              : undefined
          }
          onLoadRuntimeGoal={onLoadRuntimeGoal}
          onOpenRuntimeTask={onOpenRuntimeTask}
        />
      )}
    />
  )
}

function RuntimeTaskProgressSummary({
  item,
  binding,
  compact,
  progressDisplay = 'compact',
  active,
  changeRequestSnapshot,
  repairingChangeRequest,
  onContinueChangeRequestRepair,
  onLoadRuntimeGoal,
  onOpenRuntimeTask,
}: {
  item: CloudLoopItem
  binding: CloudTodoBoardTaskBinding
  compact: boolean
  progressDisplay?: BoardCardProgressDisplay
  active: boolean
  changeRequestSnapshot: TaskChangeRequestSnapshot | null
  repairingChangeRequest: boolean
  onContinueChangeRequestRepair?: () => Promise<void>
  onLoadRuntimeGoal?: (address: RuntimeTaskAddress) => Promise<void>
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
}) {
  const t = useBoardTranslate()
  const { t: toolTranslate } = useTranslation('chat')
  const taskAddress = useMemo<RuntimeTaskAddress>(
    () => ({
      deviceId: binding.device_id,
      taskId: binding.task_id,
      ...(binding.modelSelection
        ? { runtimeHandle: { modelSelection: binding.modelSelection } }
        : {}),
    }),
    [binding.device_id, binding.modelSelection, binding.task_id]
  )
  useEffect(() => {
    if (binding.runtimeGoalLoaded || !onLoadRuntimeGoal) return
    void onLoadRuntimeGoal(taskAddress)
  }, [binding.runtimeGoalLoaded, onLoadRuntimeGoal, taskAddress])
  const { activity, responsePreview } = useRuntimeTaskProjection(
    compact ? taskAddress : null,
    active
  )
  const taskTitle = binding.task_title || binding.task_id
  const showCompactChangeRequest = compact && Boolean(changeRequestSnapshot?.changeRequest)

  return (
    <IssueCardTaskSummary
      itemId={item.id}
      bindingId={binding.id}
      title={taskTitle}
      compact={compact}
      focused={progressDisplay === 'focused'}
      goal={binding.runtimeGoal?.objective}
      goalLoading={!binding.runtimeGoalLoaded && Boolean(onLoadRuntimeGoal)}
      translate={t}
      activity={{
        ...activity,
        tools: activity.tools.map(block => ({
          id: block.id,
          text: runtimeToolActivityText(block, toolTranslate),
          running: block.status !== 'done' && block.status !== 'error',
        })),
      }}
      responsePreview={responsePreview}
      reserveTrailingAction={showCompactChangeRequest}
      hideTaskIcon={Boolean(changeRequestSnapshot?.changeRequest)}
      status={
        <DshContributionSlotSurface
          attachedClassName="contents"
          props={{
            binding,
            compact,
            itemId: item.id,
            onContinueRepair: onContinueChangeRequestRepair,
            repairing: repairingChangeRequest,
            snapshot: changeRequestSnapshot,
          }}
          slot={WEWORK_DSH_SLOTS.boardCardStatus}
        />
      }
      conversation={
        !compact ? (
          <TemporaryChatPanel
            key={`${taskAddress.deviceId}:${taskAddress.taskId}`}
            currentProject={null}
            source={taskAddress}
            instanceId={`cloud-todo-card:${item.id}:${binding.id}`}
            testId={`cloud-todo-card-popup-conversation-${item.id}`}
            initialAddress={taskAddress}
            runtimeContext={{ cloudProjectId: String(item.cloud_project_id) }}
            sendEphemeral={false}
            collapseComposerWhenIdle
            initialScrollPosition="latest"
            emptyStateText={t('todo.task_progress_empty', '暂无任务进展详情')}
            placeholder={t('workbench.task_activity_inline_placeholder')}
            onOpenRuntimeTask={onOpenRuntimeTask}
          />
        ) : null
      }
    />
  )
}

function useRuntimeTaskProjection(
  address: RuntimeTaskAddress | null,
  active: boolean
): {
  activity: RuntimeLiveActivity
  responsePreview: string | null
} {
  const subscribe = useCallback(
    (listener: () => void) =>
      address
        ? subscribeRuntimeConversation(address, listener, {
            retainWhileSubscribed: false,
          })
        : () => undefined,
    [address]
  )
  const getSnapshot = useCallback(
    () => (address ? getRuntimeConversationTurns(address) : EMPTY_RUNTIME_CONVERSATION_TURNS),
    [address]
  )
  const turns = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return useMemo(() => runtimeTaskProgress(turns, active), [active, turns])
}
