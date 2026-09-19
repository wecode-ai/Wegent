import { MessageSquare, X } from 'lucide-react'
import { ComposerAttachmentBadges } from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'
import type { Attachment, AttachmentUploadProgress } from '@/types/api'
import type { CodeCommentContext } from '@/types/workspace-files'
import { useAttachmentImageServices } from '../useAttachmentImageServices'
import { CodeCommentPreview } from '../CodeCommentPreview'

interface AttachmentBadgesProps {
  attachments: Attachment[]
  uploadingFiles: Map<string, AttachmentUploadProgress>
  errors: Map<string, string>
  codeComments?: CodeCommentContext[]
  onRemoveAttachment: (attachmentId: number) => void
  onShowTextAttachment?: (attachment: Attachment) => void
  onClearCodeComments?: () => void
}

function CodeCommentBadge({
  comments,
  onRemove,
}: {
  comments: CodeCommentContext[]
  onRemove?: () => void
}) {
  const { t } = useTranslation('common')
  const count = comments.length

  return (
    <CodeCommentPreview comments={comments} testId="code-comment-context-preview">
      <div
        data-testid="code-comment-context-badge"
        tabIndex={0}
        className="relative inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 pr-7 text-xs font-medium text-text-primary shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        <MessageSquare className="h-3.5 w-3.5 text-text-secondary" />
        <span>{t('workbench.code_comment_count', { count })}</span>
        {onRemove && (
          <button
            type="button"
            data-testid="remove-code-comment-context-button"
            onClick={event => {
              event.stopPropagation()
              onRemove()
            }}
            className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-text-primary text-background shadow-sm transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            aria-label={t('workbench.remove_code_comments')}
          >
            <X className="h-2.5 w-2.5" />
          </button>
        )}
      </div>
    </CodeCommentPreview>
  )
}

export function AttachmentBadges({
  codeComments = [],
  onClearCodeComments,
  ...props
}: AttachmentBadgesProps) {
  const { t } = useTranslation('common')
  const imageServices = useAttachmentImageServices()
  return (
    <ComposerAttachmentBadges
      {...props}
      imageServices={imageServices}
      labels={{
        showText: t('workbench.show_text_attachment_in_composer'),
        appshot: t('workbench.appshot_attachment_label', '应用快照'),
      }}
      leading={
        codeComments.length ? (
          <CodeCommentBadge comments={codeComments} onRemove={onClearCodeComments} />
        ) : undefined
      }
    />
  )
}
