import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createCollaborationTranslator, type CollaborationGroup } from '@wegent/collaboration'
import { IssueActivityTools } from '@wegent/collaboration/issue-detail/IssueActivityTools'
import type { ProjectChatClient, ProjectChatMessage } from '@wegent/chat-core'
import type { ChatGroupApi, ChatGroupMember } from '@/api/chatGroups'
import { Button } from '@/components/ui/button'
import { ChatMessage } from '@/features/todo/TaskActivityMessage'
import { isPublicStandInMessage, issueActivityRole } from '@/features/todo/issueActivityRole'
import { resolveMessageRunStatus } from '@/features/todo/taskActivityMessageUtils'
import { copyTextToClipboard } from '@/lib/clipboard'
import { useTranslation } from '@/hooks/useTranslation'
import type { ThreadActionContext } from './threadActions'
import { useGroupThreadActions } from './threadActionsContext'
import { canOperateThreadExecution, createThreadExecutionActions } from './threadExecutionActions'
import {
  currentThreadExecutionTarget,
  currentThreadHumanDispatch,
  threadAssignmentIdentity,
} from './threadExecutionIdentity'

interface Presentation {
  renderMessage(message: ProjectChatMessage): ReactNode
}

/** Execution cards share the conversation stream; there is no second message feed. */
export function ThreadExecutionActivity({
  context,
  active = true,
  groups,
  chat,
  messages,
  members,
  locale,
  focused,
  onReply,
  onConfigure,
  onChanged,
  children,
}: {
  context: ThreadActionContext | null
  active?: boolean
  groups: ChatGroupApi
  chat?: ProjectChatClient
  messages: ProjectChatMessage[]
  members: ChatGroupMember[]
  locale: 'zh-CN' | 'en'
  focused: string | null
  onReply?(message: ProjectChatMessage): void
  onConfigure(): void
  onChanged(): void
  children(presentation: Presentation): ReactNode
}) {
  const { t } = useTranslation('common')
  const host = useGroupThreadActions()
  const { t: collaboration } = useTranslation('collaboration')
  const translate = useMemo(() => createCollaborationTranslator(locale), [locale])
  const account = context?.accountScope
  const api = context?.api
  const groupId = context?.group.id
  const itemId = context?.item.id
  const actor = context?.participation?.current_user_id
  const assignment = context ? threadAssignmentIdentity(context.item) : ''
  const enabled = active && canOperateThreadExecution(context)
  const scope = useMemo(
    () => ({ account, api, groupId, itemId, actor, groups, chat, active, assignment, enabled }),
    [account, api, groupId, itemId, actor, groups, chat, active, assignment, enabled]
  )
  const [resource, setResource] = useState<{
    scope: object
    crew: CollaborationGroup | null
    error: string | null
  } | null>(null)
  const crewId = context?.item.assignee_group_id
  const crewSource = context?.item.assignee_group_source_id
  useEffect(() => {
    if (!enabled || !crewId || !crewSource || !api) return
    let current = true
    void Promise.resolve()
      .then(() => {
        if (!api.projects.listCollaborationGroups)
          throw new Error(collaboration('executionContextUnavailable'))
        return api.projects.listCollaborationGroups(crewSource)
      })
      .then(crews => {
        if (current)
          setResource({
            scope,
            crew:
              crews.find(
                crew =>
                  crew.id === crewId &&
                  (crew.binding_owner_id == null || crew.binding_owner_id === crewSource)
              ) ?? null,
            error: null,
          })
      })
      .catch(cause => {
        if (current)
          setResource({
            scope,
            crew: null,
            error: cause instanceof Error ? cause.message : String(cause),
          })
      })
    return () => {
      current = false
    }
  }, [crewId, crewSource, api, scope, collaboration, enabled])
  const crew = resource?.scope === scope ? resource.crew : null
  const current = useRef<object | null>(scope)
  const pending = useRef<object | null>(null)
  const [state, setState] = useState<{
    scope: object
    busy: string | null
    error: string | null
  } | null>(null)
  useLayoutEffect(() => {
    current.current = scope
    return () => {
      current.current = null
      pending.current = null
    }
  }, [scope])
  const busy = state?.scope === scope ? state.busy : null
  const error = state?.scope === scope ? state.error : null
  const actions = () => {
    if (!context) throw new Error(collaboration('executionContextUnavailable'))
    return createThreadExecutionActions({
      context,
      groups,
      chat,
      unavailable: collaboration('executionContextUnavailable'),
      isCurrent: () => current.current === scope,
      onChanged,
    })
  }
  const perform = async (key: string, operation: () => Promise<void>, execution = true) => {
    if ((execution && !enabled) || pending.current) return
    const request = {}
    pending.current = request
    setState({ scope, busy: key, error: null })
    try {
      await operation()
      if (current.current === scope) setState({ scope, busy: null, error: null })
    } catch (cause) {
      if (current.current === scope)
        setState({
          scope,
          busy: null,
          error: cause instanceof Error ? cause.message : String(cause),
        })
    } finally {
      if (pending.current === request) pending.current = null
    }
  }
  const people = members.map(member => ({
    id: member.user_id,
    user_id: member.user_id,
    user_name: member.name,
    email: null,
    role: member.role,
  }))
  const task = context?.item
  const aiState = task?.ai_state
    ? { ...task.ai_state, status: task.ai_state.status ?? undefined }
    : undefined
  const human =
    task && actor != null ? currentThreadHumanDispatch(task, messages, crew, actor) : null
  const target = task ? currentThreadExecutionTarget(task, messages, crew) : null
  const hasExecution = Boolean(
    task &&
    (task.execution_state ||
      task.ai_state?.status ||
      target ||
      human ||
      task.status === 'in_review')
  )
  const controls = task && enabled && hasExecution && (
    <div
      className="flex flex-wrap items-center justify-end gap-2"
      data-testid="thread-execution-actions"
    >
      <Button
        size="sm"
        variant="ghost"
        data-testid="thread-execution-assignee"
        onClick={onConfigure}
      >
        {collaboration('assignee')}
      </Button>
      {human && (
        <Button
          size="sm"
          variant="ghost"
          data-testid="thread-execution-human-start"
          disabled={Boolean(busy)}
          onClick={() => void perform('human', () => actions().startHumanTask())}
        >
          {t('workbench.task_activity_start_assigned_work')}
        </Button>
      )}
      <IssueActivityTools
        task={task}
        assignedAgent={target ? {} : null}
        canApprove={task.can_approve === true}
        running={Boolean(busy)}
        translate={translate}
        copyText={copyTextToClipboard}
        onApprove={
          task.can_approve ? () => void perform('approve', () => actions().approve()) : undefined
        }
        onReject={
          task.can_approve
            ? () => {
                const reason = window.prompt(t('workbench.task_activity_reject_reason_prompt'))
                if (reason !== null) void perform('reject', () => actions().reject(reason))
              }
            : undefined
        }
        onAccept={
          task.status === 'in_review' && task.permissions?.edit_content
            ? () => void perform('accept', () => actions().accept())
            : undefined
        }
        onRun={
          target && chat?.executeTaskComment
            ? () => void perform('rerun', () => actions().rerun())
            : undefined
        }
      />
    </div>
  )

  const renderMessage = (message: ProjectChatMessage) => {
    if (!task || message.sender.type !== 'agent' || isPublicStandInMessage(message)) return null
    const status = resolveMessageRunStatus(aiState, message)
    const stoppable =
      !['completed', 'succeeded', 'failed', 'cancelled', 'skipped', 'interrupted'].includes(
        status ?? ''
      ) &&
      Number.isSafeInteger(Number(message.metadata.execution_id)) &&
      Number(message.metadata.execution_id) > 0
    return (
      <article
        key={message.messageId}
        data-testid={`group-message-${message.messageId}`}
        data-message-id={message.messageId}
        data-message-side="other"
        data-focused={focused === message.messageId || undefined}
      >
        <ChatMessage
          message={message}
          members={people}
          mine={false}
          compact
          plain
          showInlineExecutionStatus
          agentRole={issueActivityRole(message)}
          allowBackendExecutionFallback={false}
          taskAiState={aiState}
          flash={focused === message.messageId}
          stopping={busy === `stop:${message.messageId}`}
          onOpenExecution={
            context && message.runtimeAddress && host?.openExecution
              ? () =>
                  void perform(
                    `open:${message.messageId}`,
                    () => host.openExecution!(context, message),
                    false
                  )
              : undefined
          }
          onStopExecution={
            enabled && stoppable
              ? () => void perform(`stop:${message.messageId}`, () => actions().stop(message))
              : undefined
          }
        />
        {target?.messageId === message.messageId && controls}
        {onReply && message.content.trim() && (
          <Button
            size="sm"
            variant="ghost"
            data-testid={`cloud-task-activity-reply-toggle-${message.messageId}`}
            onClick={() => onReply(message)}
          >
            {t('interactions.reply')}
          </Button>
        )}
      </article>
    )
  }
  return (
    <>
      {children({ renderMessage })}
      {!target && controls}
      {(error || (enabled && resource?.scope === scope && resource.error)) && (
        <p role="alert" className="text-sm text-error">
          {error || resource?.error}
        </p>
      )}
    </>
  )
}
