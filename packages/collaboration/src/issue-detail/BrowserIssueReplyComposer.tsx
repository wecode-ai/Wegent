import type { CollaborationTranslate } from '../i18n'
import { ConversationQueuePanel } from '../conversation/ConversationQueuePanel'
import { IssueThreadReplyComposer } from './IssueThreadReplyComposer'
import { useBrowserTaskDraft } from './browserTaskDraftContext'
import { useBrowserIssueReplies } from './browserIssueRepliesContext'
import type { IssueMentionGroup } from './issueCommentMentions'

export function BrowserIssueReplyComposer({
  rootId,
  disabled,
  canAttach,
  translate: t,
  mentionGroups,
}: {
  rootId: string
  disabled: boolean
  canAttach: boolean
  translate: CollaborationTranslate
  mentionGroups?: IssueMentionGroup[]
}) {
  const reply = useBrowserIssueReplies()
  const draft = useBrowserTaskDraft(`issue-reply:${rootId}`)
  if (!reply) throw new Error('BrowserIssueReplies is required')
  return (
    <>
      <div data-testid={`collaboration-chat-queue-${rootId}`}>
        <ConversationQueuePanel
          translate={t}
          queuedMessages={reply.queue.messages(rootId)}
          guidanceMessages={[]}
          onCancelQueuedMessage={id => reply.queue.cancel(rootId, id)}
        />
      </div>
      {reply.error && (
        <div role="alert" className="task-detail-comment-inline-error">
          {reply.error}
          <button
            type="button"
            className="ml-2 underline"
            data-testid={`collaboration-chat-retry-${rootId}`}
            onClick={reply.retry}
          >
            {t('activity.retry')}
          </button>
        </div>
      )}
      <IssueThreadReplyComposer
        rootId={rootId}
        disabled={disabled}
        attachments={canAttach ? draft.attachments : undefined}
        aiError={reply.queue.error(rootId)}
        mentionGroups={mentionGroups}
        onSend={async (text, mentions) =>
          reply.queue.enqueue(rootId, text, draft.attachments.attachments, mentions)
        }
        labels={{
          placeholder: t('workbench.task_activity_inline_placeholder'),
          send: t('workbench.send_message'),
          attach: t('workbench.task_activity_attachment_attach'),
          removeAttachment: t('workbench.task_activity_attachment_remove'),
          uploading: t('workbench.task_activity_attachment_uploading'),
          sendFailed: t('workbench.project_chat_send_failed'),
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
    </>
  )
}
