import { IssueThreadReplyComposer, type CollaborationTranslate } from '@wegent/collaboration'
import type { ComposerExternalMentionCandidate } from '@wegent/collaboration/composer/composerAutocompleteInputTypes'
import { useTranslation } from '@/hooks/useTranslation'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useWorkbenchAttachments } from '@/features/workbench/useWorkbenchAttachments'
import type { Attachment } from '@/types/api'
import type { ProjectChatMention } from '@/api/backend/projectChatSocket'

export interface CardCommentSendResult {
  ok: boolean
  error?: string
}

interface CardCommentComposerProps {
  rootId: string
  projectId: string
  disabled: boolean
  placeholder: string
  aiError?: string | null
  mentionCandidates?: ComposerExternalMentionCandidate[]
  translate: CollaborationTranslate
  onSend: (
    text: string,
    mentions: ProjectChatMention[],
    attachments: Attachment[]
  ) => Promise<CardCommentSendResult>
}

export function CardCommentComposer({
  rootId,
  projectId,
  disabled,
  placeholder,
  aiError,
  mentionCandidates = [],
  translate,
  onSend,
}: CardCommentComposerProps) {
  const { t } = useTranslation('common')
  const { services } = useWorkbenchPaneContext()
  const attachmentSelection = useWorkbenchAttachments({
    uploadAttachment: services.attachmentApi?.uploadAttachment,
    deleteAttachment: services.attachmentApi?.deleteAttachment,
    scopeKey: `task-activity-${projectId}:card-${rootId}`,
  })
  return (
    <IssueThreadReplyComposer
      rootId={rootId}
      disabled={disabled}
      attachments={attachmentSelection}
      aiError={aiError}
      mentionCandidates={mentionCandidates}
      translate={translate}
      onSend={(text, mentions) => onSend(text, mentions, attachmentSelection.attachments)}
      labels={{
        placeholder,
        send: t('workbench.send_message'),
        attach: t('workbench.task_activity_attachment_attach'),
        removeAttachment: t('workbench.task_activity_attachment_remove'),
        uploading: t('workbench.task_activity_attachment_uploading'),
        sendFailed: t('workbench.project_chat_send_failed'),
      }}
    />
  )
}
