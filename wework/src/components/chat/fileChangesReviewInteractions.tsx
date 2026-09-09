import { Check, MessageSquare, Undo2 } from 'lucide-react'
import type { GitPatchAction } from '@/api/environment'
import { useTranslation } from '@/hooks/useTranslation'
import type { DiffCommentSelection } from './fileChangesReviewUtils'

export function ReviewPatchActionButton({
  action,
  scope,
  disabled,
  pending,
  onClick,
}: {
  action: GitPatchAction
  scope: 'file' | 'hunk'
  disabled: boolean
  pending: boolean
  onClick: () => void
}) {
  const { t } = useTranslation('chat')
  const label = t(`file_changes.actions.${action}_${scope}`)
  const Icon = action === 'revert' ? Undo2 : Check

  return (
    <button
      type="button"
      data-testid={`file-changes-review-${action}-${scope}-button`}
      disabled={disabled}
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex h-7 shrink-0 items-center gap-1 rounded px-1.5 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-45"
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="hidden xl:inline">{pending ? t('file_changes.applying') : label}</span>
    </button>
  )
}

export function DiffCommentComposer({
  selection,
  comment,
  onCommentChange,
  onCancel,
  onSubmit,
}: {
  selection: DiffCommentSelection
  comment: string
  onCommentChange: (value: string) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  const { t } = useTranslation('chat')

  return (
    <div
      data-testid="file-changes-review-comment-composer"
      className="absolute bottom-4 left-4 right-4 z-popover rounded-xl border border-border bg-background p-3 shadow-xl"
    >
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-text-primary">
        <MessageSquare className="h-4 w-4" />
        <span className="min-w-0 flex-1 truncate">
          {selection.path}:{selection.startLine}
          {selection.endLine === selection.startLine ? '' : `-${selection.endLine}`}
        </span>
      </div>
      <textarea
        autoFocus
        data-testid="file-changes-review-comment-input"
        value={comment}
        onChange={event => onCommentChange(event.target.value)}
        placeholder={t('file_changes.comment_placeholder')}
        className="min-h-20 w-full resize-none rounded-lg border border-border bg-surface p-2 text-sm outline-none focus:border-primary"
      />
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          data-testid="file-changes-review-comment-cancel-button"
          className="h-8 rounded-md px-3 text-sm text-text-secondary hover:bg-muted"
          onClick={onCancel}
        >
          {t('file_changes.cancel')}
        </button>
        <button
          type="button"
          data-testid="file-changes-review-add-comment-button"
          className="h-8 rounded-md bg-text-primary px-3 text-sm font-medium text-background disabled:opacity-50"
          disabled={!comment.trim()}
          onClick={onSubmit}
        >
          {t('file_changes.add_comment')}
        </button>
      </div>
    </div>
  )
}
