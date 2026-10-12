import { IssueThreadReplyComposer, type CollaborationTranslate } from '@wegent/collaboration'
import type { ComposerExternalMentionCandidate } from '@wegent/collaboration/composer/composerAutocompleteInputTypes'
import { useTranslation } from '@/hooks/useTranslation'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useWorkbenchAttachments } from '@/features/workbench/useWorkbenchAttachments'
import type { Attachment, RuntimeTaskAddress } from '@/types/api'
import type { ProjectChatMention } from '@/api/backend/projectChatSocket'
import { ReplyPredictionProvider } from '@/features/reply-predictions/ReplyPredictionProvider'

export interface CardCommentSendResult {
  ok: boolean
  error?: string
}

interface CardCommentComposerProps {
  predictionAddress?: RuntimeTaskAddress | null
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
  predictionAddress,
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
    <ReplyPredictionProvider
      address={predictionAddress}
      blocked={
        disabled ||
        attachmentSelection.attachments.length > 0 ||
        attachmentSelection.uploadingFiles.size > 0
      }
    >
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
    </ReplyPredictionProvider>
  )
}
