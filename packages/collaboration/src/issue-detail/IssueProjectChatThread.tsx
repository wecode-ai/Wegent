import { BrowserIssueReplyComposer } from './BrowserIssueReplyComposer'
import { useBrowserIssueReplies } from './browserIssueRepliesContext'
import type { ExecutionTaskSummary } from './IssueChatMessage'
import {
  messageRuntimeExecutionTarget,
  type RuntimeExecutionTarget,
} from './runtimeExecutionTarget'
import { IssueChatMessage } from './IssueChatMessage'
import type { ComponentProps } from 'react'
import { useIssueActivityExecutionStatus } from './useIssueActivityExecutionStatus'
import { IssueThreadReplyComposer } from './IssueThreadReplyComposer'
import { useIssueCommentAttachments, issueCommentBody } from './useIssueCommentAttachments'
import { useIssueMentionGroups } from './useIssueMentionGroups'
import type { ProjectChatMention, ProjectChatMessage } from '@wegent/chat-core'
import type { RuntimeTaskAddress } from '@wegent/chat-core/runtime'
import type { CollaborationAttachment, CollaborationExecution } from '../types'
import type { CollaborationAgent, CollaborationMember } from '../types'
import { IssueActivityThread, type IssueActivityThreadModel } from './IssueActivityThread'

function ActivityMessage({
  singleExecution,
  ...props
}: ComponentProps<typeof IssueChatMessage> & {
  singleExecution: boolean
}) {
  const { status } = useIssueActivityExecutionStatus(props.message, singleExecution)
  return <IssueChatMessage {...props} executionStatus={status} />
}

export function IssueProjectChatThread({
  thread,
  canComment,
  send,
  translate,
  executions,
  onOpenExecution,
  onStopExecution,
  stoppingMessageId,
  onOpenAttachment,
  taskSummaryForMessage,
  singleExecutionForMessage,
  upload,
  remove,
  members,
  agents,
}: {
  thread: IssueActivityThreadModel<ProjectChatMessage>
  upload?(file: File): Promise<CollaborationAttachment>
  remove?(id: string): Promise<void>
  canComment: boolean
  send(text: string, replyToMessageId: string, mentions?: ProjectChatMention[]): Promise<unknown>
  members?: CollaborationMember[]
  agents?: CollaborationAgent[]
  translate(key: string, fallback?: string, options?: Record<string, string | number>): string
  executions: CollaborationExecution[]
  taskSummaryForMessage?(message: ProjectChatMessage): ExecutionTaskSummary | undefined
  singleExecutionForMessage?(message: ProjectChatMessage): boolean
  onOpenAttachment?(id: string, filename: string): void
  onOpenExecution?(target: RuntimeExecutionTarget): void
  onStopExecution?(messageId: string, address: RuntimeTaskAddress): Promise<void>
  stoppingMessageId?: string | null
}) {
  const runtimeReplies = useBrowserIssueReplies()
  const attachments = useIssueCommentAttachments(upload, remove)
  const mentionGroups = useIssueMentionGroups(
    members ?? [],
    agents ?? [],
    translate
  )
  const rootId = thread.root.messageId
  const runs = [thread.root, ...thread.replies].filter(message => message.sender.type === 'agent')
  function renderMessage(message: ProjectChatMessage, eventOnly = false) {
    const execution = executions.find(run => run.id === Number(message.metadata.execution_id))
    const target = messageRuntimeExecutionTarget(message, execution)
    const singleExecution = singleExecutionForMessage?.(target?.activityMessage ?? message) ?? false
    return (
      <ActivityMessage
        key={message.messageId}
        message={target?.activityMessage ?? message}
        singleExecution={singleExecution}
        mine={false}
        compact
        plain
        eventOnly={eventOnly}
        taskSummary={taskSummaryForMessage?.(message)}
        translate={translate}
        testId={`collaboration-chat-message-${message.messageId}`}
        executionTestId={execution ? `collaboration-open-execution-${execution.id}` : undefined}
        onOpenAttachment={onOpenAttachment}
        onOpenUrl={url => {
          window.open(url, '_blank', 'noopener,noreferrer')
        }}
        onOpenExecution={
          target && onOpenExecution
            ? () => onOpenExecution({ ...target, singleExecution })
            : undefined
        }
        onStopExecution={
          target && onStopExecution
            ? () => void onStopExecution(message.messageId, target.address)
            : undefined
        }
        stopping={stoppingMessageId === message.messageId}
      />
    )
  }
  return (
    <IssueActivityThread
      cardAttributes={{ 'data-testid': `collaboration-chat-card-${rootId}` }}
      message={renderMessage(thread.root)}
      replies={thread.replies.length ? thread.replies.map(message => renderMessage(message)) : null}
      repliesTestId={`collaboration-chat-replies-${rootId}`}
      composer={
        canComment && runtimeReplies ? (
          <BrowserIssueReplyComposer
            rootId={rootId}
            disabled={!canComment}
            canAttach={Boolean(upload)}
            translate={translate}
            mentionGroups={mentionGroups}
          />
        ) : canComment ? (
          <IssueThreadReplyComposer
            rootId={rootId}
            disabled={!canComment}
            attachments={upload ? attachments : undefined}
            mentionGroups={mentionGroups}
            onSend={async (text, mentions) => {
              await send(
                issueCommentBody(text, attachments.attachments),
                rootId,
                ...(mentions.length ? [mentions] : [])
              )
              return { ok: true }
            }}
            labels={{
              placeholder: translate('todo.reply_placeholder'),
              send: translate('todo.send_message'),
              attach: translate('todo.attach_file'),
              removeAttachment: translate('todo.remove_attachment'),
              uploading: translate('todo.attachments_uploading'),
              sendFailed: translate('todo.send_failed'),
            }}
            testIds={{
              composer: `collaboration-chat-reply-${rootId}`,
              input: `collaboration-chat-reply-input-${rootId}`,
              send: `collaboration-chat-reply-send-${rootId}`,
              attach: `collaboration-chat-attach-${rootId}`,
              file: `collaboration-chat-attach-${rootId}-input`,
              error: `collaboration-chat-reply-error-${rootId}`,
            }}
          />
        ) : null
      }
      eventLabel={translate('todo.execution_count', '{{count}} 条运行动态', {
        count: runs.length,
      })}
      eventTestId={`collaboration-chat-events-${rootId}`}
      events={runs.length ? runs.map(message => renderMessage(message, true)) : null}
    />
  )
}
