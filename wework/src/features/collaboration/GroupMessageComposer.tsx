import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { X } from 'lucide-react'
import type { ProjectChatMention } from '@wegent/chat-core'
import type { CollaborationTranslate, SharedWorkspaceApi } from '@wegent/collaboration'
import {
  IssueThreadReplyComposer,
  issueCommentBody,
  useIssueCommentAttachments,
  useIssueMentionCandidates,
} from '@wegent/collaboration'
import type { ChatGroupMember } from '@/api/chatGroups'
import { useTranslation } from '@/hooks/useTranslation'
import type { ComposerInputHandle } from '@wegent/collaboration/composer'
import type { GroupReplyTarget } from './groupReply'

export interface GroupMessageComposerProps {
  scopeKey: string
  threadId: string | null
  members: ChatGroupMember[]
  api: SharedWorkspaceApi
  translate: CollaborationTranslate
  onSend(
    text: string,
    replyToMessageId: string | undefined,
    mentions: ProjectChatMention[]
  ): Promise<unknown>
  currentUserId?: string | null
  replyTarget?: GroupReplyTarget | null
  onCancelReply(target: GroupReplyTarget): void
  inputRef?: RefObject<ComposerInputHandle | null>
}

/** Reuse the established chat editor, upload lifecycle and structured mentions. */
export function GroupMessageComposer(props: GroupMessageComposerProps) {
  return <ScopedGroupMessageComposer key={props.scopeKey} {...props} />
}

function ScopedGroupMessageComposer({
  scopeKey,
  threadId,
  members,
  api,
  translate,
  onSend,
  currentUserId,
  replyTarget,
  onCancelReply,
  inputRef,
}: GroupMessageComposerProps) {
  const { t } = useTranslation('collaboration')
  const { t: common } = useTranslation('common')
  const editor = useRef<ComposerInputHandle | null>(null)
  const reply = replyTarget?.scopeKey === scopeKey ? replyTarget : null
  useEffect(() => {
    if (reply) (inputRef ?? editor).current?.focus()
  }, [reply, inputRef])
  const attachments = useIssueCommentAttachments(
    threadId ? file => api.attachments.upload(threadId, file) : undefined,
    threadId ? id => api.attachments.remove(id) : undefined
  )
  const people = useMemo(
    () =>
      members.map(member => ({
        id: member.user_id,
        user_id: member.user_id,
        user_name: String(member.user_id) === currentUserId ? t('you') : member.name,
        role: member.role,
        email: null,
      })),
    [members, currentUserId, t]
  )
  const mentions = useIssueMentionCandidates(people, [], translate)
  return (
    <div className="space-y-2">
      {reply && (
        <div
          role="group"
          aria-label={common('interactions.reply')}
          data-testid="group-reply-context"
          data-reply-to-message-id={reply.messageId}
          className="flex items-start gap-2 rounded-lg border border-border bg-hover px-3 py-2"
        >
          <div className="min-w-0 flex-1 border-l-2 border-border pl-3 text-xs text-text-muted">
            <span className="block truncate font-medium text-text-secondary">
              {common('interactions.reply')} · {reply.senderName}
            </span>
            <span className="line-clamp-2 whitespace-pre-wrap break-words">{reply.content}</span>
          </div>
          <button
            type="button"
            data-testid="group-reply-cancel"
            aria-label={translate('common.cancel')}
            title={translate('common.cancel')}
            onClick={() => onCancelReply(reply)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-muted hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:h-11 max-md:w-11"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      <IssueThreadReplyComposer
        rootId={threadId ?? 'group'}
        disabled={false}
        translate={translate}
        inputRef={inputRef ?? editor}
        mentionCandidates={mentions}
        attachments={threadId ? attachments : undefined}
        labels={{
          placeholder: t('messagePlaceholder'),
          send: translate('todo.send_message'),
          attach: translate('todo.attach_file'),
          removeAttachment: translate('todo.remove_attachment'),
          uploading: translate('todo.attachments_uploading'),
          sendFailed: translate('todo.send_failed'),
        }}
        testIds={{
          composer: 'group-message-composer',
          input: 'group-message-input',
          send: 'group-message-send',
          attach: 'group-message-attach',
          file: 'group-message-file',
          error: 'group-message-error',
        }}
        onSend={async (text, selected) => {
          await onSend(issueCommentBody(text, attachments.attachments), reply?.messageId, selected)
          if (reply) onCancelReply(reply)
          return { ok: true }
        }}
      />
    </div>
  )
}
