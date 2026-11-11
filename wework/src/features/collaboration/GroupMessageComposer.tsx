import { useMemo } from 'react'
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

/** Reuse the established chat editor, upload lifecycle and structured mentions. */
export function GroupMessageComposer({
  threadId,
  members,
  api,
  translate,
  onSend,
  currentUserId,
}: {
  threadId: string | null
  members: ChatGroupMember[]
  api: SharedWorkspaceApi
  translate: CollaborationTranslate
  onSend(text: string, mentions: ProjectChatMention[]): Promise<unknown>
  currentUserId?: string | null
}) {
  const { t } = useTranslation('collaboration')
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
    <IssueThreadReplyComposer
      rootId={threadId ?? 'group'}
      disabled={false}
      translate={translate}
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
        await onSend(issueCommentBody(text, attachments.attachments), selected)
        return { ok: true }
      }}
    />
  )
}
