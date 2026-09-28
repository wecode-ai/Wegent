import { RuntimeDeviceAccessNotice } from '../conversation/RuntimeDeviceAccess'
import { useRuntimeDeviceAccess } from '../conversation/useRuntimeDeviceAccess'
import { useBoardRuntimeGoals } from './useBoardRuntimeGoals'
import type { RuntimeGoal } from '@wegent/chat-core/runtime-stream-types'
import { useMemo } from 'react'
import type { RuntimeWorkListResponse } from '@wegent/chat-core/runtime-task-api-types'
import { findRuntimeTask } from '@wegent/chat-core/runtime-task-lookup'
import { IssueBoardCard, type IssueBoardCardProps } from './IssueBoardCard'
import { IssueCardTaskSummary } from './IssueCardTaskSummary'
import { runtimeTaskProgress, runtimeToolActivityText } from './runtimeTaskProgress'
import type { SharedWorkspaceRuntimeApi, WorkspaceTaskBinding } from '../ports/SharedWorkspaceApi'
import type { CollaborationIssue } from '../types'
import { isLoopItemExecutionActive } from '../my-work/model'
import { isExecutionActive } from '../issue-detail/executionStatus'
import { useRuntimeConversationSession } from '../conversation/useRuntimeConversationSession'
import { BrowserTaskConversationContent } from '../issue-detail/BrowserTaskConversationContent'
import type { CollaborationTranslate } from '../i18n'

interface BrowserBoardTask extends WorkspaceTaskBinding {
  task_id: string
  task_title: string | null
  running: boolean
}

/** Web transport adapter for the same card, progress projection and conversation as PC. */
export function BrowserIssueBoardCard({
  runtime,
  work,
  taskBindings,
  item,
  focused,
  ...props
}: Omit<
  IssueBoardCardProps<BrowserBoardTask>,
  'item' | 'progressTaskBindings' | 'renderTaskSummary'
> & {
  runtime: SharedWorkspaceRuntimeApi
  work: RuntimeWorkListResponse | null
  taskBindings: WorkspaceTaskBinding[]
  item: CollaborationIssue
  focused: boolean
}) {
  const bindings = taskBindings.map(binding => ({
    ...binding,
    task_id: binding.taskId,
    task_title: binding.taskTitle,
    running: Boolean(
      findRuntimeTask(work, { deviceId: binding.deviceId, taskId: binding.taskId })?.running
    ),
  }))
  const active = isLoopItemExecutionActive(item, isExecutionActive)
  const running = bindings.filter(binding => binding.running)
  const progress = running.length
    ? running
    : (active || item.status === 'in_review') && bindings[0]
      ? [bindings[0]]
      : []
  const current = running[0] ?? bindings[0]
  const access = useRuntimeDeviceAccess(
    runtime,
    progress.map(binding => binding.deviceId)
  )
  const goals = useBoardRuntimeGoals(
    runtime.work,
    progress
      .filter(binding => access.get(binding.deviceId) === 'allowed')
      .map(binding => ({ deviceId: binding.deviceId, taskId: binding.taskId })),
    props.translate('todo.current_conversation_goal_load_failed')
  )
  const goal = current
    ? goals.get({ deviceId: current.deviceId, taskId: current.taskId })?.goal
    : null
  return (
    <IssueBoardCard
      {...props}
      item={item}
      goal={current && goal ? { bindingId: current.id, objective: goal.objective } : null}
      progressTaskBindings={progress}
      renderTaskSummary={(binding, compact) =>
        access.get(binding.deviceId) !== 'allowed' ? (
          <RuntimeDeviceAccessNotice
            access={access.get(binding.deviceId)}
            error={access.error}
            retry={access.retry}
            translate={props.translate}
          />
        ) : (
          <BrowserRuntimeTaskSummary
            key={binding.id}
            runtime={runtime}
            item={item}
            binding={binding}
            compact={compact}
            goal={goals.get({ deviceId: binding.deviceId, taskId: binding.taskId })}
            onRetryGoal={goals.retry}
            active={binding.running || (binding.id === bindings[0]?.id && active)}
            focused={focused}
            translate={props.translate}
          />
        )
      }
    />
  )
}

function BrowserRuntimeTaskSummary({
  runtime,
  item,
  binding,
  compact,
  active,
  focused,
  translate,
  goal,
  onRetryGoal,
}: {
  goal?: { goal: RuntimeGoal | null; error: string | null }
  onRetryGoal(): void
  runtime: SharedWorkspaceRuntimeApi
  item: CollaborationIssue
  binding: BrowserBoardTask
  compact: boolean
  active: boolean
  focused: boolean
  translate: CollaborationTranslate
}) {
  const address = useMemo(
    () => ({ deviceId: binding.deviceId, taskId: binding.taskId }),
    [binding.deviceId, binding.taskId]
  )
  // The compact summary remains mounted while its popup is open, preserving live status.
  return compact ? (
    <BrowserCompactTaskSummary
      runtime={runtime}
      address={address}
      item={item}
      binding={binding}
      active={active}
      focused={focused}
      translate={translate}
    />
  ) : (
    <>
      <IssueCardTaskSummary
        goal={goal?.goal?.objective}
        goalLoading={!goal}
        itemId={item.id}
        bindingId={binding.id}
        title={binding.taskTitle || binding.taskId}
        compact={false}
        activity={{ active: false, processText: null, tools: [] }}
        responsePreview={null}
        translate={translate}
        conversation={
          <BrowserTaskConversationContent
            runtime={runtime}
            address={address}
            projectId={item.cloud_project_id}
            translate={translate}
            preview
            testId={`cloud-todo-card-popup-conversation-${item.id}`}
          />
        }
      />
      {goal?.error && (
        <div role="alert" className="px-4 py-2 text-xs text-error">
          {goal.error}
          <button
            type="button"
            data-testid={`cloud-todo-card-goal-retry-${item.id}`}
            className="ml-2 underline"
            onClick={onRetryGoal}
          >
            {translate('activity.retry')}
          </button>
        </div>
      )}
    </>
  )
}

function BrowserCompactTaskSummary({
  runtime,
  address,
  item,
  binding,
  active,
  focused,
  translate,
}: {
  runtime: SharedWorkspaceRuntimeApi
  address: { deviceId: string; taskId: string }
  item: CollaborationIssue
  binding: BrowserBoardTask
  active: boolean
  focused: boolean
  translate: CollaborationTranslate
}) {
  const { state, session } = useRuntimeConversationSession(runtime, address)
  const projection = runtimeTaskProgress(state.turns, state.running ?? active)
  return (
    <>
      <IssueCardTaskSummary
        itemId={item.id}
        bindingId={binding.id}
        title={binding.taskTitle || binding.taskId}
        compact
        focused={focused}
        translate={translate}
        responsePreview={projection.responsePreview}
        activity={{
          ...projection.activity,
          tools: projection.activity.tools.map(block => ({
            id: block.id,
            text: runtimeToolActivityText(block, key => translate(`conversation.${key}`)),
            running: block.status !== 'done' && block.status !== 'error',
          })),
        }}
      />
      {state.error && (
        <div
          role="alert"
          className="px-1 text-xs text-error"
          data-testid={`cloud-todo-card-progress-error-${item.id}`}
        >
          {state.error}
          <button
            type="button"
            data-testid={`cloud-todo-card-progress-retry-${item.id}`}
            className="ml-2 underline"
            onClick={() => void session.reload()}
          >
            {translate('activity.retry')}
          </button>
        </div>
      )}
    </>
  )
}
