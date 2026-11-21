import type { GitPatchAction } from '@/api/environment'
import { useTranslation } from '@/hooks/useTranslation'
import { isImeComposingEvent } from '@/lib/ime'
import { Popover, PopoverContent } from '@wegent/collaboration/controls/Popover'
import { controlPopup } from '@wegent/collaboration/controls/recipes'
import { Textarea as ControlTextarea } from '@wegent/collaboration/controls/Textarea'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Check, Loader2, MessageSquare, Minus, Undo2 } from 'lucide-react'
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
  const Icon = action === 'revert' ? Undo2 : action === 'unstage' ? Minus : Check

  return (
    <ControlButton
      variant="unstyled"
      type="button"
      data-testid={`file-changes-review-${action}-${scope}-button`}
      disabled={disabled}
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-primary/35 disabled:opacity-45"
    >
      {pending ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Icon className="h-3.5 w-3.5" />
      )}
    </ControlButton>
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
  const hasDraft = Boolean(comment.trim())

  return (
    <Popover
      open
      dismissible={!hasDraft}
      onOpenChange={(next, details) => {
        if (next) return
        if (hasDraft || details.event?.defaultPrevented) {
          details.cancel()
          return
        }
        onCancel()
      }}
    >
      <PopoverContent
        inline
        aria-label={t('file_changes.comment_placeholder')}
        data-testid="file-changes-review-comment-composer"
        initialFocus='[data-testid="file-changes-review-comment-input"]'
        className={controlPopup + ' absolute bottom-4 left-4 right-4 p-3'}
      >
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-text-primary">
          <MessageSquare className="h-4 w-4" />
          <span className="min-w-0 flex-1 truncate">
            {selection.path}:{selection.startLine}
            {selection.endLine === selection.startLine ? '' : `-${selection.endLine}`}
          </span>
        </div>
        <ControlTextarea
          data-testid="file-changes-review-comment-input"
          value={comment}
          onChange={event => onCommentChange(event.target.value)}
          onKeyDown={event => {
            if (isImeComposingEvent(event)) return
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && hasDraft) {
              event.preventDefault()
              onSubmit()
            }
          }}
          placeholder={t('file_changes.comment_placeholder')}
          className="min-h-20 w-full resize-none rounded-lg border border-border bg-surface p-2 text-sm outline-none keyboard:focus:border-primary"
        />
        <div className="mt-2 flex justify-end gap-2">
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="file-changes-review-comment-cancel-button"
            className="h-8 rounded-md px-3 text-sm text-text-secondary hover:bg-muted"
            onClick={onCancel}
          >
            {t('file_changes.cancel')}
          </ControlButton>
          <ControlButton
            variant="primary"
            size="sm"
            type="button"
            data-testid="file-changes-review-add-comment-button"
            className="h-8 rounded-md bg-text-primary px-3 text-sm font-medium text-background disabled:opacity-50"
            disabled={!comment.trim()}
            onClick={onSubmit}
          >
            {t('file_changes.add_comment')}
          </ControlButton>
        </div>
      </PopoverContent>
    </Popover>
  )
}
