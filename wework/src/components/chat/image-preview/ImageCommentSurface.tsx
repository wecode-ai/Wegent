import { useRef, useState, type PointerEvent } from 'react'
import { Trash2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ImageComment, ImagePoint } from './imageEdit'

export type ImageCommentDraft = ImageComment & { index?: number }

const pinClass =
  'absolute z-[1] grid size-7 -translate-y-full place-items-center rounded-full rounded-bl-sm bg-blue-600 text-xs font-medium text-white ring-1 ring-white'

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
      <button
        type="button"
        aria-label={t('image_preview.comment_surface')}
        data-testid="attachment-image-edit-surface"
        className={`absolute inset-0 size-full touch-none ${hover && !draft ? 'cursor-none' : 'cursor-crosshair'}`}
        disabled={busy}
        onPointerDown={event => {
          start.current =
            event.button === 0
              ? { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
              : null
        }}
        onPointerMove={event => setHover(pointAt(event))}
        onPointerLeave={() => {
          start.current = null
          setHover(null)
        }}
        onPointerCancel={() => {
          start.current = null
        }}
        onPointerUp={event => {
          const pointer = start.current
          start.current = null
          if (
            !pointer ||
            pointer.pointerId !== event.pointerId ||
            Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 8
          )
            return
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
            <button
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
            </button>
          )
      )}
      {draft && (
        <>
          <span
            aria-hidden="true"
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
              <input
                autoFocus
                data-testid="attachment-image-comment-input"
                className="min-w-0 flex-1 bg-transparent px-2 text-sm outline-none"
                aria-label={t('image_preview.comment')}
                placeholder={t('image_preview.comment_placeholder')}
                value={draft.text}
                disabled={busy}
                onChange={event => onDraft({ ...draft, text: event.target.value })}
              />
            ) : (
              <textarea
                autoFocus
                rows={3}
                data-testid="attachment-image-comment-input"
                className="w-full resize-none bg-transparent px-2 py-1 text-sm outline-none"
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
                  <button
                    type="button"
                    data-testid="attachment-image-comment-delete"
                    className="grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-muted"
                    aria-label={t('image_preview.delete')}
                    disabled={busy}
                    onClick={() => onDelete(editingIndex)}
                  >
                    <Trash2 className="size-4" />
                  </button>
                  <button
                    type="button"
                    data-testid="attachment-image-comment-cancel"
                    className="ml-auto rounded-full px-2 py-1 text-sm hover:bg-muted"
                    disabled={busy}
                    onClick={() => onDraft(null)}
                  >
                    {t('image_preview.cancel')}
                  </button>
                </>
              )}
              <button
                type="submit"
                className="min-h-7 rounded-full bg-blue-600 px-2 text-sm text-white disabled:opacity-40"
                data-testid="attachment-image-comment-save"
                disabled={busy || !draft.text.trim()}
              >
                {t('image_preview.save_comment')}
              </button>
            </div>
          </form>
        </>
      )}
    </>
  )
}
