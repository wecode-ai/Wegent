import { Input } from '@ui-sdk/react/input'
import { Button } from '@ui-sdk/react/button'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { useRef, useState, type PointerEvent } from 'react'
import { useFocusRequest } from '@wegent/collaboration/dom-events'
import {
  Eraser,
  GripVertical,
  MessageSquareDashed,
  PenLine,
  RectangleHorizontal,
  Scan,
  Square,
  RectangleVertical,
  Smartphone,
  X,
} from 'lucide-react'
import { ActionMenu } from '@/components/common/ActionMenu'
import { useTranslation } from '@/hooks/useTranslation'
import { ImageCommentSurface, type ImageCommentDraft } from './ImageCommentSurface'
import { useMarkupEditor } from './useMarkupEditor'
import {
  finishImagePointerTrace,
  imagePointerSamples,
  startImagePointerTrace,
} from './imagePointerSamples'
import { markupSurfaceSize, strokeGeometry } from './imageMarkup'
import { cn } from '@/lib/utils'
import { reportImageCommentStage } from '@/lib/file-preview-diagnostics'
import { imageAspectRatios, type ImageComment, type ImageEdit, type ImageStroke } from './imageEdit'

type EditMode = 'markup' | 'comment' | 'erase'

function saveImageComment(comments: ImageComment[], draft: ImageCommentDraft): ImageComment[] {
  const { index, x, y, text } = draft
  const saved = { x, y, text: text.trim() }
  if (!saved.text) return comments
  return index === undefined
    ? [...comments, saved]
    : comments.map((item, itemIndex) => (itemIndex === index ? saved : item))
}

const ratioIcons = [Square, RectangleVertical, Smartphone, RectangleHorizontal, RectangleHorizontal]
const tools = [
  { id: 'markup', icon: PenLine },
  { id: 'comment', icon: MessageSquareDashed },
  { id: 'background', icon: Scan },
  { id: 'erase', icon: Eraser },
] as const
const actionClass =
  'flex min-h-8 shrink-0 items-center gap-1.5 rounded-md px-2 hover:bg-white/15 focus-visible:outline focus-visible:outline-2 disabled:opacity-50 max-md:min-h-11'

export function useImagePreviewEditor(
  submit: (edit: ImageEdit, reset: () => void) => void,
  busy: boolean,
  portalContainer: HTMLElement | null,
  imageSize: { width: number; height: number } | null,
  compact = false,
  saveMarkup = false,
  initialComments: ImageComment[] = []
) {
  const { t } = useTranslation('common')
  const [mode, setMode] = useState<EditMode | null>(null)
  const [history, setHistory] = useState<{ strokes: ImageStroke[]; count: number }>({
    strokes: [],
    count: 0,
  })
  const [stroke, setStroke] = useState<ImageStroke | null>(null)
  const activeEraseGesture = useRef<{ pointerId: number; stroke: ImageStroke } | null>(null)
  const [brushWidth, setBrushWidth] = useState(4)
  const [instructions, setInstructions] = useState('')
  const [markupCommenting, setMarkupCommenting] = useState(false)
  const surfaceSize = markupSurfaceSize(imageSize ?? { width: 100, height: 100 })
  const markup = useMarkupEditor(busy, surfaceSize, markupCommenting, portalContainer, () => {
    if (!markupCommenting) return
    commitComment()
    setMarkupCommenting(false)
  })
  const strokes = history.strokes.slice(0, history.count)
  const [comments, setComments] = useState<ImageComment[]>(initialComments)
  const sendCommentsButton = useRef<HTMLButtonElement>(null)
  const [focusRequest, setFocusRequest] = useState(0)
  useFocusRequest(sendCommentsButton, focusRequest, {
    enabled: focusRequest > 0,
    preventScroll: true,
  })
  const [comment, setComment] = useState<ImageCommentDraft | null>(null)
  const toolbarDrag = useRef<{
    x: number
    y: number
    pointerX: number
    pointerY: number
    pointerId: number
  } | null>(null)
  const controls = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState({ x: 0, y: 0 })

  function selectMode(next: EditMode | null) {
    setMode(next)
    setHistory({ strokes: [], count: 0 })
    clearEraseGesture()
    setInstructions('')
    setMarkupCommenting(false)
    markup.reset()
    setComments(initialComments)
    setComment(null)
  }

  function onSubmit(edit: ImageEdit) {
    if (edit.kind === 'comment' || edit.kind === 'markup') {
      reportImageCommentStage('editor_submit', {
        kind: edit.kind,
        saveToDraft: saveMarkup && edit.kind === 'markup',
        pinCount: edit.comments?.length ?? 0,
      })
    }
    submit(edit, () => selectMode(null))
  }

  function clearEraseGesture() {
    activeEraseGesture.current = null
    setStroke(null)
  }

  function commitEraseGesture(
    gesture: { pointerId: number; stroke: ImageStroke },
    samples: ReturnType<typeof imagePointerSamples>
  ) {
    const stroke = samples.length
      ? { ...gesture.stroke, points: [...gesture.stroke.points, ...samples] }
      : gesture.stroke
    setHistory(current => ({
      strokes: [...current.strokes.slice(0, current.count), stroke],
      count: current.count + 1,
    }))
    clearEraseGesture()
  }

  const canSendMarkup =
    markup.marks.length > 0 ||
    markup.pendingText ||
    comments.length > 0 ||
    comment?.text.trim() ||
    instructions.trim()

  const currentComments = comment ? saveImageComment(comments, comment) : comments

  function submitMarkup() {
    const marks = markup.pendingText ? [...markup.marks, markup.pendingText] : markup.marks
    if (!saveMarkup && marks.length === 0 && !instructions.trim()) {
      onSubmit({ kind: 'comment', comments: currentComments })
      return
    }
    onSubmit({
      kind: 'markup',
      marks,
      instructions,
      ...(currentComments.length ? { comments: currentComments } : {}),
    })
  }

  function commitComment() {
    if (comment?.text.trim()) {
      reportImageCommentStage('pin_saved', { editing: comment.index !== undefined })
      setComments(current => saveImageComment(current, comment))
    }
    setComment(null)
  }

  function moveToolbar(x: number, y: number) {
    const viewer = controls.current?.parentElement?.parentElement
    if (!viewer || !controls.current) return
    const limit = Math.max(0, (viewer.clientWidth - controls.current.offsetWidth) / 2 - 8)
    setOffset({
      x: Math.max(-limit, Math.min(limit, x)),
      y: Math.max(90 - viewer.clientHeight, Math.min(0, y)),
    })
  }

  function finishToolbarDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = toolbarDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    toolbarDrag.current = null
  }

  const commentSurface = (
    <ImageCommentSurface
      comments={comments}
      draft={comment}
      busy={busy}
      onDraft={setComment}
      onSave={explicit => {
        if (explicit && mode === 'comment') setFocusRequest(value => value + 1)
        commitComment()
      }}
      onDelete={index => {
        setComments(current => current.filter((_, itemIndex) => index !== itemIndex))
        setComment(null)
      }}
    />
  )

  const surface =
    mode === 'comment' ? (
      commentSurface
    ) : mode === 'markup' ? (
      <>
        {markup.surface}
        {markupCommenting && commentSurface}
      </>
    ) : mode === 'erase' ? (
      <svg
        aria-label={t(`image_preview.${mode}`)}
        data-testid="attachment-image-edit-surface"
        className="absolute inset-0 size-full touch-none cursor-crosshair"
        viewBox={`0 0 ${surfaceSize.width} ${surfaceSize.height}`}
        onPointerDown={event => {
          if (busy || event.button !== 0 || activeEraseGesture.current) return
          const point = imagePointerSamples(event).at(-1)
          if (!point) return
          event.currentTarget.setPointerCapture(event.pointerId)
          startImagePointerTrace(event, 'selection-eraser')
          const gesture = {
            pointerId: event.pointerId,
            stroke: { points: [point], width: brushWidth },
          }
          activeEraseGesture.current = gesture
          setStroke(gesture.stroke)
        }}
        onPointerMove={event => {
          const gesture = activeEraseGesture.current
          if (!gesture || gesture.pointerId !== event.pointerId) return
          const samples = imagePointerSamples(event)
          if (!samples.length) return
          const next = {
            ...gesture,
            stroke: { ...gesture.stroke, points: [...gesture.stroke.points, ...samples] },
          }
          activeEraseGesture.current = next
          setStroke(next.stroke)
        }}
        onPointerUp={event => {
          const gesture = activeEraseGesture.current
          if (!gesture || gesture.pointerId !== event.pointerId) return
          const samples = imagePointerSamples(event)
          finishImagePointerTrace(event)
          commitEraseGesture(gesture, samples)
        }}
        onPointerCancel={event => {
          const gesture = activeEraseGesture.current
          if (!gesture || gesture.pointerId !== event.pointerId) return
          finishImagePointerTrace(event)
          clearEraseGesture()
        }}
        onLostPointerCapture={event => {
          const gesture = activeEraseGesture.current
          if (!gesture || gesture.pointerId !== event.pointerId) return
          finishImagePointerTrace(event)
          commitEraseGesture(gesture, [])
        }}
      >
        {(stroke ? [...strokes, stroke] : strokes).map((line, index) => (
          <path
            key={index}
            d={strokeGeometry(line).path}
            fill="none"
            stroke="#ff3333"
            strokeOpacity={0.55}
            strokeWidth={line.width}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </svg>
    ) : null

  const toolbar = (
    <div
      className="absolute inset-x-0 bottom-4 z-10 flex flex-col items-center gap-2 px-2"
      style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
    >
      {mode === 'markup' && !saveMarkup && (
        <Input
          data-testid="attachment-image-markup-instructions"
          aria-label={t('image_preview.markup_instructions')}
          placeholder={t('image_preview.markup_instructions')}
          className="w-72 max-w-full rounded-xl border border-border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
          disabled={busy}
          value={instructions}
          onChange={event => setInstructions(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Enter' || busy || !canSendMarkup || event.nativeEvent.isComposing)
              return
            event.preventDefault()
            submitMarkup()
          }}
        />
      )}
      {mode === 'erase' && (
        <div className="rounded-lg bg-neutral-800 px-3 py-1 text-sm text-white">
          {t('image_preview.erase_hint')}
        </div>
      )}
      <div
        ref={controls}
        role="toolbar"
        aria-label={t('image_preview.tools')}
        className="flex max-w-full items-center gap-1 overflow-x-auto rounded-xl bg-neutral-800 p-1 text-sm text-neutral-100 shadow-lg"
        data-testid="attachment-image-edit-tools"
      >
        <Button
          type="button"
          className={cn(actionClass, 'cursor-grab touch-none px-1')}
          aria-label={t('image_preview.move_toolbar')}
          data-testid="attachment-image-toolbar-handle"
          onPointerDown={event => {
            if (event.button !== 0 || toolbarDrag.current) return
            toolbarDrag.current = {
              ...offset,
              pointerX: event.clientX,
              pointerY: event.clientY,
              pointerId: event.pointerId,
            }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={event => {
            const start = toolbarDrag.current
            if (!start || start.pointerId !== event.pointerId) return
            moveToolbar(
              start.x + event.clientX - start.pointerX,
              start.y + event.clientY - start.pointerY
            )
          }}
          onPointerUp={finishToolbarDrag}
          onPointerCancel={finishToolbarDrag}
          onLostPointerCapture={finishToolbarDrag}
          onKeyDown={event => {
            const moves: Record<string, [number, number]> = {
              ArrowLeft: [-12, 0],
              ArrowRight: [12, 0],
              ArrowUp: [0, -12],
              ArrowDown: [0, 12],
            }
            const delta = moves[event.key]
            if (event.key === 'Home') setOffset({ x: 0, y: 0 })
            else if (delta) moveToolbar(offset.x + delta[0], offset.y + delta[1])
            else return
            event.preventDefault()
            event.stopPropagation()
          }}
        >
          <GripVertical className="size-4" />
        </Button>
        {mode === 'comment' ? (
          <>
            <span
              className={cn('px-1.5', !comments.length && 'text-neutral-400')}
              data-testid="attachment-image-comment-count"
              aria-live="polite"
            >
              {comments.length
                ? t('image_preview.comment_count', { count: comments.length })
                : t('image_preview.comment_hint')}
            </span>
            <ControlButton
              type="button"
              variant="primary"
              className={cn(actionClass, 'rounded-xl')}
              data-testid="attachment-image-edit-send"
              ref={sendCommentsButton}
              disabled={busy || !currentComments.length}
              onClick={() => onSubmit({ kind: 'comment', comments: currentComments })}
            >
              {t('image_preview.send')}
            </ControlButton>
            <Button
              type="button"
              className={actionClass}
              data-testid="attachment-image-edit-cancel"
              aria-label={t('image_preview.cancel')}
              disabled={busy}
              onClick={() => selectMode(null)}
            >
              <X className="size-4" />
            </Button>
          </>
        ) : mode ? (
          <>
            <Button
              type="button"
              className={actionClass}
              data-testid="attachment-image-edit-cancel"
              disabled={busy}
              onClick={() => selectMode(null)}
            >
              {t('image_preview.cancel')}
            </Button>
            {mode === 'markup' ? (
              <>
                {markup.palette}
                <Button
                  type="button"
                  data-testid="attachment-image-markup-comment"
                  aria-label={t('image_preview.comment')}
                  aria-pressed={markupCommenting}
                  className={cn(actionClass, 'aria-pressed:bg-white/20')}
                  disabled={busy}
                  onClick={() => {
                    commitComment()
                    markup.commitPendingText()
                    setMarkupCommenting(value => !value)
                  }}
                >
                  <MessageSquareDashed className="size-4" />
                </Button>
              </>
            ) : (
              <Input
                type="range"
                min={1}
                max={12}
                step={0.5}
                value={String(brushWidth)}
                className="w-20 accent-white"
                aria-label={t('image_preview.brush_size')}
                data-testid="attachment-image-erase-brush-size"
                disabled={busy}
                onChange={event => setBrushWidth(event.target.valueAsNumber)}
              />
            )}
            <Button
              type="button"
              className={actionClass}
              data-testid="attachment-image-edit-undo"
              disabled={busy || (mode === 'markup' ? !markup.canUndo : !strokes.length)}
              onClick={
                mode === 'markup'
                  ? markup.undo
                  : () => setHistory(current => ({ ...current, count: current.count - 1 }))
              }
            >
              {t('image_preview.undo')}
            </Button>
            <Button
              type="button"
              className={actionClass}
              data-testid="attachment-image-edit-redo"
              disabled={
                busy ||
                (mode === 'markup' ? !markup.canRedo : history.count === history.strokes.length)
              }
              onClick={
                mode === 'markup'
                  ? markup.redo
                  : () => setHistory(current => ({ ...current, count: current.count + 1 }))
              }
            >
              {t('image_preview.redo')}
            </Button>
            <ControlButton
              type="button"
              variant={mode === 'markup' && saveMarkup ? 'primary' : 'unstyled'}
              className={cn(actionClass, mode === 'markup' && saveMarkup && 'rounded-xl')}
              data-testid={
                mode === 'markup' && saveMarkup
                  ? 'attachment-image-edit-save'
                  : 'attachment-image-edit-send'
              }
              disabled={busy || (mode === 'markup' ? !canSendMarkup : !strokes.length)}
              onClick={() =>
                mode === 'markup' ? submitMarkup() : onSubmit({ kind: mode, strokes })
              }
            >
              {t(mode === 'markup' && saveMarkup ? 'image_preview.save' : 'image_preview.send')}
            </ControlButton>
          </>
        ) : (
          <>
            {tools.map(({ id, icon: Icon }) => (
              <Button
                key={id}
                type="button"
                data-testid={`attachment-image-tool-${id}`}
                className={actionClass}
                aria-label={t(`image_preview.${id}`)}
                title={compact ? t(`image_preview.${id}`) : undefined}
                disabled={busy}
                onClick={() => (id === 'background' ? onSubmit({ kind: id }) : selectMode(id))}
              >
                <Icon className="size-4" />
                {!compact && t(`image_preview.${id}`)}
              </Button>
            ))}
            <ActionMenu
              testId="attachment-image-tool-resize"
              ariaLabel={t('image_preview.resize')}
              triggerLabel={compact ? undefined : t('image_preview.resize')}
              triggerClassName={actionClass}
              icon={RectangleHorizontal}
              placement="bottom-end"
              portalContainer={portalContainer}
              disabled={busy}
              showTriggerTooltip={compact}
              items={imageAspectRatios.map((ratio, index) => ({
                testId: `attachment-image-resize-${ratio}`,
                icon: ratioIcons[index],
                label: (
                  <span className="flex w-full min-w-36 items-center justify-between gap-4">
                    {t(`image_preview.ratio_${index}`)}
                    <span className="text-muted-foreground">{ratio}</span>
                  </span>
                ),
                onSelect: () => onSubmit({ kind: 'resize', ratio }),
              }))}
            />
          </>
        )}
      </div>
    </div>
  )

  return {
    surface,
    toolbar,
    mode,
    cancel: () => {
      if (mode === 'markup' && markup.cancelText) markup.cancelText()
      else if (comment) setComment(null)
      else if (markupCommenting) setMarkupCommenting(false)
      else selectMode(null)
    },
  }
}
