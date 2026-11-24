import { Textarea } from '@ui-sdk/react/textarea'
import { Input } from '@ui-sdk/react/input'
import { Button } from '@ui-sdk/react/button'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { useRef, useState, type PointerEvent } from 'react'
import { Trash2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ImageComment, ImagePoint } from './imageEdit'

export type ImageCommentDraft = ImageComment & { index?: number }

const pinClass =
  'absolute z-[1] grid size-7 -translate-y-full place-items-center rounded-full rounded-bl-sm bg-blue-600 text-xs font-medium text-white ring-1 ring-white max-md:size-11'

function pointStyle(point: ImagePoint) {
  return { left: `${point.x}%`, top: `${point.y}%` }
}

function pointAt(event: PointerEvent<HTMLButtonElement>): ImagePoint {
  const rect = event.currentTarget.getBoundingClientRect()
  return {
    x: Math.max(0, Math.min(100, (100 * (event.clientX - rect.left)) / rect.width)),
    y: Math.max(0, Math.min(100, (100 * (event.clientY - rect.top)) / rect.height)),
  }
}

export function ImageCommentSurface({
  comments,
  draft,
  busy,
  onDraft,
  onSave,
  onDelete,
}: {
  comments: ImageComment[]
  draft: ImageCommentDraft | null
  busy: boolean
  onDraft(draft: ImageCommentDraft | null): void
  onSave(explicit: boolean): void
  onDelete(index: number): void
}) {
  const { t } = useTranslation('common')
  const [hover, setHover] = useState<ImagePoint | null>(null)
  const start = useRef<{ x: number; y: number; pointerId: number } | null>(null)
  const editingIndex = draft?.index
  const switchDraft = (next: ImageCommentDraft) => {
    if (draft?.text.trim()) onSave(false)
    onDraft(next)
  }

  return (
    <>
      <Button
        type="button"
        aria-label={t('image_preview.comment_surface')}
        data-testid="attachment-image-edit-surface"
        className={`absolute inset-0 size-full touch-none ${hover && !draft ? 'cursor-none' : 'cursor-crosshair'}`}
        disabled={busy}
        onPointerDown={event => {
          if (start.current) return
          start.current =
            event.button === 0
              ? { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
              : null
        }}
        onPointerMove={event => {
          const pointer = start.current
          if (pointer && pointer.pointerId !== event.pointerId) return
          setHover(pointAt(event))
        }}
        onPointerLeave={event => {
          const pointer = start.current
          if (pointer && pointer.pointerId !== event.pointerId) return
          start.current = null
          setHover(null)
        }}
        onPointerCancel={event => {
          const pointer = start.current
          if (pointer && pointer.pointerId !== event.pointerId) return
          start.current = null
        }}
        onPointerUp={event => {
          const pointer = start.current
          if (!pointer || pointer.pointerId !== event.pointerId) return
          start.current = null
          if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 8) return
          switchDraft({ ...pointAt(event), text: '' })
        }}
        onClick={event => {
          if (event.detail === 0 && !draft) switchDraft({ x: 50, y: 50, text: '' })
        }}
      />
      {hover && !draft && !busy && (
        <span
          aria-hidden="true"
          className={`${pinClass} pointer-events-none`}
          style={pointStyle(hover)}
        />
      )}
      {comments.map(
        (comment, index) =>
          draft?.index !== index && (
            <Button
              key={index}
              type="button"
              data-testid="attachment-image-comment-pin"
              aria-label={t('image_preview.edit_comment', { number: index + 1 })}
              className={pinClass}
              style={pointStyle(comment)}
              title={comment.text}
              disabled={busy}
              onClick={() => switchDraft({ ...comment, index })}
            >
              {index + 1}
            </Button>
          )
      )}
      {draft && (
        <>
          <span
            role="img"
            aria-label={t('image_preview.comment')}
            data-testid="attachment-image-comment-draft-pin"
            className={`${pinClass} pointer-events-none`}
            style={pointStyle(draft)}
          />
          <form
            className={`absolute z-10 flex w-64 max-w-[calc(100vw-1rem)] gap-1 rounded-2xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg ${editingIndex === undefined ? 'items-center' : 'flex-col'}`}
            style={{
              left: `clamp(min(0px, calc(50% - 8rem)), calc(${draft.x}% - 8rem), max(calc(100% - 16rem), calc(50% - 8rem)))`,
              top: `${draft.y}%`,
              transform: draft.y > 75 ? 'translateY(calc(-100% - 2rem))' : 'translateY(0.5rem)',
            }}
            onSubmit={event => {
              event.preventDefault()
              if (!busy && draft.text.trim()) onSave(true)
            }}
          >
            {editingIndex === undefined ? (
              <Input
                autoFocus
                data-testid="attachment-image-comment-input"
                className="min-w-0 flex-1 bg-transparent px-2 text-sm outline-none max-md:min-h-11"
                aria-label={t('image_preview.comment')}
                placeholder={t('image_preview.comment_placeholder')}
                value={draft.text}
                disabled={busy}
                onChange={event => onDraft({ ...draft, text: event.target.value })}
              />
            ) : (
              <Textarea
                autoFocus
                rows={3}
                data-testid="attachment-image-comment-input"
                className="w-full resize-none bg-transparent px-2 py-1 text-sm outline-none max-md:min-h-11"
                aria-label={t('image_preview.edit_comment', { number: editingIndex + 1 })}
                value={draft.text}
                disabled={busy}
                onChange={event => onDraft({ ...draft, text: event.target.value })}
                onKeyDown={event => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    if (draft.text.trim()) onSave(true)
                  }
                }}
              />
            )}
            <div className="flex shrink-0 items-center gap-1">
              {editingIndex !== undefined && (
                <>
                  <Button
                    type="button"
                    data-testid="attachment-image-comment-delete"
                    className="grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-muted max-md:size-11"
                    aria-label={t('image_preview.delete')}
                    disabled={busy}
                    onClick={() => onDelete(editingIndex)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    data-testid="attachment-image-comment-cancel"
                    className="ml-auto min-h-7 rounded-full px-2 py-1 text-sm hover:bg-muted max-md:min-h-11 max-md:min-w-11"
                    disabled={busy}
                    onClick={() => onDraft(null)}
                  >
                    {t('image_preview.cancel')}
                  </Button>
                </>
              )}
              <ControlButton
                type="submit"
                variant="primary"
                className="min-h-7 rounded-full px-2 text-sm disabled:opacity-40 max-md:min-h-11 max-md:min-w-11"
                data-testid="attachment-image-comment-save"
                disabled={busy || !draft.text.trim()}
              >
                {t('image_preview.save_comment')}
              </ControlButton>
            </div>
          </form>
        </>
      )}
    </>
  )
}
