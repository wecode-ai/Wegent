import { useId, useRef, useState, type PointerEvent } from 'react'
import { Eraser, MousePointer2, PenLine, Shapes, Type } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  eraseMarks,
  strokeGeometry,
  markupShapes,
  moveMark,
  type ImageMark,
  type MarkupShape,
  type MarkupStroke,
} from './imageMarkup'
import {
  finishImagePointerTrace,
  imagePointerSamples,
  startImagePointerTrace,
} from './imagePointerSamples'
import type { ImagePoint, ImageStroke } from './imageEdit'

const tools = [
  { id: 'select', icon: MousePointer2 },
  { id: 'pen', icon: PenLine },
  { id: 'text', icon: Type },
  { id: 'eraser', icon: Eraser },
] as const
type Tool = (typeof tools)[number]['id'] | MarkupShape
const controlClass =
  'grid size-8 shrink-0 place-items-center rounded-md hover:bg-white/15 aria-pressed:bg-white/20 disabled:opacity-50'

type Gesture =
  | { kind: 'draw'; stroke: MarkupStroke }
  | { kind: 'erase'; stroke: ImageStroke }
  | { kind: 'move'; index: number; start: ImagePoint; mark: ImageMark }

export function useMarkupEditor(
  busy: boolean,
  surfaceSize: { width: number; height: number },
  commenting: boolean,
  onChooseTool: () => void
) {
  const { t } = useTranslation('common')
  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState('#ff3333')
  const [width, setWidth] = useState(0.65)
  const [eraserWidth, setEraserWidth] = useState(4)
  const maskId = useId()
  const [history, setHistory] = useState({ frames: [[]] as ImageMark[][], index: 0 })
  const marks = history.frames[history.index]!
  const activeGesture = useRef<Gesture | null>(null)
  const [preview, setPreview] = useState<ImageMark | null>(null)
  const [erasure, setErasure] = useState<ImageStroke | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [textDraft, setTextDraft] = useState<{ point: ImagePoint; text: string } | null>(null)
  const draftText = textDraft?.text.trim()
  const pendingText =
    textDraft && draftText ? { point: textDraft.point, text: draftText, color, size: 4 } : null

  function commit(next: ImageMark[]) {
    setHistory(current => ({
      frames: [...current.frames.slice(0, current.index + 1), next],
      index: current.index + 1,
    }))
  }

  function reset() {
    activeGesture.current = null
    setHistory({ frames: [[]], index: 0 })
    setPreview(null)
    setErasure(null)
    setSelected(null)
    setTextDraft(null)
    setTool('pen')
  }

  function chooseTool(next: Tool) {
    onChooseTool()
    setSelected(null)
    commitPendingText()
    setTool(next)
  }

  function commitPendingText() {
    if (pendingText) commit([...marks, pendingText])
    setTextDraft(null)
  }

  function changeHistory(delta: number) {
    setHistory(current => ({ ...current, index: current.index + delta }))
    setSelected(null)
  }

  function pointerDown(event: PointerEvent<SVGSVGElement>) {
    if (busy || event.button !== 0) return
    if (tool === 'pen') startImagePointerTrace(event, 'pen', width)
    const point = imagePointerSamples(event).at(-1)
    if (!point) return
    const hit = (event.target as Element)
      .closest('[data-mark-index]')
      ?.getAttribute('data-mark-index')
    const index = hit === null || hit === undefined ? -1 : Number(hit)
    const mark = marks[index]
    if (tool === 'text') {
      setTextDraft({ point, text: '' })
      return
    }
    if (tool === 'eraser') {
      const stroke = { points: [point], width: eraserWidth }
      activeGesture.current = { kind: 'erase', stroke }
      setErasure(stroke)
    } else if (tool === 'select') {
      setSelected(mark ? index : null)
      if (!mark) return
      activeGesture.current = { kind: 'move', index, start: point, mark }
    } else {
      const stroke = { points: [point], width, color, ...(tool === 'pen' ? {} : { shape: tool }) }
      activeGesture.current = { kind: 'draw', stroke }
      setPreview(stroke)
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    if (tool === 'eraser') startImagePointerTrace(event, 'markup-eraser')
  }

  function updateGesture(points: ImagePoint[]) {
    const gesture = activeGesture.current
    const point = points.at(-1)
    if (!gesture || gesture.kind === 'erase' || !point) return null
    if (gesture.kind === 'move') {
      return moveMark(gesture.mark, point.x - gesture.start.x, point.y - gesture.start.y)
    }
    const stroke = gesture.stroke
    const next = {
      ...stroke,
      points: stroke.shape ? [stroke.points[0]!, point] : [...stroke.points, ...points],
    }
    activeGesture.current = { ...gesture, stroke: next }
    return next
  }

  function clearGesture() {
    activeGesture.current = null
    setPreview(null)
    setErasure(null)
  }

  function extendErasure(stroke: ImageStroke, points: ImagePoint[]) {
    const next = { ...stroke, points: [...stroke.points, ...points] }
    activeGesture.current = { kind: 'erase', stroke: next }
    return next
  }

  function pointerUp(event: PointerEvent<SVGSVGElement>) {
    const gesture = activeGesture.current
    if (!gesture) return
    const samples = imagePointerSamples(event)
    finishImagePointerTrace(event)
    const point = samples.at(-1)
    if (!point) {
      clearGesture()
      return
    }
    if (gesture.kind === 'erase') {
      const updated = eraseMarks(marks, extendErasure(gesture.stroke, samples))
      if (updated.some((mark, index) => mark !== marks[index])) commit(updated)
      clearGesture()
      return
    }
    if (gesture.kind === 'move' && point.x === gesture.start.x && point.y === gesture.start.y) {
      clearGesture()
      return
    }
    const next = updateGesture(samples)
    if (gesture && next) {
      if (gesture.kind === 'draw') commit([...marks, next])
      else commit(marks.map((mark, index) => (index === gesture.index ? next : mark)))
    }
    clearGesture()
  }

  const workingMarks = erasure
    ? eraseMarks(marks, erasure)
    : preview
      ? selected === null
        ? [...marks, preview]
        : marks.map((mark, index) => (index === selected ? preview : mark))
      : marks
  const surface = (
    <>
      <svg
        aria-label={t('image_preview.markup')}
        data-testid={commenting ? undefined : 'attachment-image-edit-surface'}
        className="absolute inset-0 size-full touch-none cursor-crosshair"
        viewBox={`0 0 ${surfaceSize.width} ${surfaceSize.height}`}
        tabIndex={commenting ? -1 : 0}
        onPointerDown={pointerDown}
        onPointerMove={event => {
          const gesture = activeGesture.current
          if (!gesture) return
          const samples = imagePointerSamples(event)
          if (!samples.length) return
          if (gesture.kind === 'erase') setErasure(extendErasure(gesture.stroke, samples))
          else setPreview(updateGesture(samples))
        }}
        onPointerUp={pointerUp}
        onPointerCancel={event => {
          finishImagePointerTrace(event)
          clearGesture()
        }}
        onLostPointerCapture={event => {
          finishImagePointerTrace(event)
          clearGesture()
        }}
        onKeyDown={event => {
          if (!busy && selected !== null && (event.key === 'Delete' || event.key === 'Backspace')) {
            event.preventDefault()
            commit(marks.filter((_, index) => index !== selected))
            setSelected(null)
          }
        }}
      >
        <defs>
          {workingMarks.map(
            (mark, index) =>
              mark.erasures && (
                <mask
                  id={`${maskId}-${index}`}
                  key={index}
                  maskUnits="userSpaceOnUse"
                  x="0"
                  y="0"
                  width={surfaceSize.width}
                  height={surfaceSize.height}
                >
                  <rect width={surfaceSize.width} height={surfaceSize.height} fill="white" />
                  {mark.erasures.map((erase, cutIndex) => (
                    <path
                      key={cutIndex}
                      d={strokeGeometry(erase).path}
                      fill="none"
                      stroke="black"
                      strokeWidth={erase.width}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  ))}
                </mask>
              )
          )}
        </defs>
        {workingMarks.map((mark, index) => {
          const geometry = 'text' in mark ? null : strokeGeometry(mark)
          return (
            <g
              key={index}
              data-mark-index={index}
              opacity={selected === index ? 0.65 : 1}
              mask={mark.erasures ? `url(#${maskId}-${index})` : undefined}
            >
              {'text' in mark ? (
                <text
                  transform={`translate(${mark.point.x} ${mark.point.y}) scale(${mark.size / 14})`}
                  fill={mark.color}
                  className="font-sans text-sm"
                >
                  {mark.text}
                </text>
              ) : (
                <path
                  d={geometry?.path}
                  fill={geometry?.filled ? mark.color : 'none'}
                  stroke={geometry?.filled ? 'none' : mark.color}
                  strokeWidth={mark.width}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
            </g>
          )
        })}
      </svg>
      {textDraft && (
        <form
          className="absolute z-10 flex -translate-y-full gap-1 rounded-lg bg-popover p-1 shadow-md"
          style={{
            left: `${Math.min((100 * textDraft.point.x) / surfaceSize.width, 65)}%`,
            top: `${Math.max(12, (100 * textDraft.point.y) / surfaceSize.height)}%`,
          }}
          onSubmit={event => {
            event.preventDefault()
            if (!pendingText || busy) return
            commitPendingText()
          }}
        >
          <input
            autoFocus
            className="w-36 bg-transparent px-1 text-sm"
            data-testid="attachment-image-markup-text-input"
            aria-label={t('image_preview.markup_text')}
            value={textDraft.text}
            onChange={event => setTextDraft({ ...textDraft, text: event.target.value })}
          />
          <button
            type="submit"
            className="rounded-md bg-blue-600 px-1.5 text-white"
            data-testid="attachment-image-markup-save-text"
            disabled={!textDraft.text.trim() || busy}
          >
            {t('image_preview.save')}
          </button>
        </form>
      )}
    </>
  )

  const palette = (
    <>
      {tools.map(({ id, icon: Icon }) => (
        <button
          key={id}
          type="button"
          className={controlClass}
          aria-label={t(`image_preview.markup_${id}`)}
          title={t(`image_preview.markup_${id}`)}
          aria-pressed={!commenting && tool === id}
          disabled={busy}
          data-testid={`attachment-image-markup-${id}`}
          onClick={() => chooseTool(id)}
        >
          <Icon className="size-4" />
        </button>
      ))}
      <label className="flex items-center gap-1">
        <Shapes className="size-4" />
        <select
          className="rounded bg-neutral-800 text-sm"
          aria-label={t('image_preview.markup_shapes')}
          data-testid="attachment-image-markup-shapes"
          disabled={busy}
          value={markupShapes.find(shape => shape === tool) ?? ''}
          onChange={event => {
            const shape = markupShapes.find(item => item === event.target.value)
            if (shape) chooseTool(shape)
          }}
        >
          <option value="" disabled>
            {t('image_preview.markup_shapes')}
          </option>
          {markupShapes.map(shape => (
            <option key={shape} value={shape}>
              {t(`image_preview.markup_${shape}`)}
            </option>
          ))}
        </select>
      </label>
      <input
        type="color"
        className="size-7 shrink-0"
        aria-label={t('image_preview.markup_color')}
        data-testid="attachment-image-markup-color"
        value={color}
        disabled={busy}
        onChange={event => setColor(event.target.value)}
      />
      <input
        type="range"
        className="w-16 shrink-0 accent-white"
        aria-label={t(
          tool === 'eraser' ? 'image_preview.brush_size' : 'image_preview.markup_width'
        )}
        data-testid="attachment-image-markup-width"
        value={tool === 'eraser' ? eraserWidth : width}
        disabled={busy}
        min={0.2}
        max={tool === 'eraser' ? 12 : 4}
        step={0.05}
        onChange={event =>
          (tool === 'eraser' ? setEraserWidth : setWidth)(event.target.valueAsNumber)
        }
      />
    </>
  )

  return {
    marks,
    pendingText,
    commitPendingText,
    surface,
    palette,
    reset,
    canUndo: history.index > 0,
    canRedo: history.index < history.frames.length - 1,
    undo: () => changeHistory(-1),
    redo: () => changeHistory(1),
    cancelText: textDraft ? () => setTextDraft(null) : null,
  }
}
