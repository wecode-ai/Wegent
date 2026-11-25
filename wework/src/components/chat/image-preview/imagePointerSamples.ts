import type { PointerEvent } from 'react'
import { createFilePreviewTraceId, logFilePreviewDiagnostic } from '@/lib/file-preview-diagnostics'
import type { ImagePoint } from './imageEdit'
import { markupSurfaceSize } from './imageMarkup'

type PenSample = {
  x: number
  y: number
  time: number
  speed: number | null
  pressure: number
  stylus: boolean
}

type PointerTrace = {
  tool: 'pen' | 'markup-eraser' | 'selection-eraser'
  pointerId: number
  startedAt: number
  previousSampleAt: number
  moveEvents: number
  coalescedSamples: number
  deliveredPoints: number
  maxSampleGapMs: number
  maxDispatchDelayMs: number
  pen?: PenSample
  width?: number
}

const traces = new WeakMap<SVGSVGElement, PointerTrace>()

export function startImagePointerTrace(
  event: PointerEvent<SVGSVGElement>,
  tool: PointerTrace['tool'],
  width?: number
) {
  traces.set(event.currentTarget, {
    tool,
    pointerId: event.pointerId,
    startedAt: event.timeStamp,
    previousSampleAt: event.timeStamp,
    moveEvents: 0,
    coalescedSamples: 0,
    deliveredPoints: tool === 'pen' ? 0 : 1,
    maxSampleGapMs: 0,
    maxDispatchDelayMs: 0,
    width,
  })
}

export function finishImagePointerTrace(event: PointerEvent<SVGSVGElement>) {
  const trace = traces.get(event.currentTarget)
  if (!trace || trace.pointerId !== event.pointerId) return
  traces.delete(event.currentTarget)
  logFilePreviewDiagnostic(createFilePreviewTraceId(), 'image_pointer_gesture', {
    tool: trace.tool,
    pointerType: event.pointerType,
    endEvent: event.type,
    durationMs: Math.round(event.timeStamp - trace.startedAt),
    moveEvents: trace.moveEvents,
    coalescedSamples: trace.coalescedSamples,
    deliveredPoints: trace.deliveredPoints,
    maxSampleGapMs: Math.round(trace.maxSampleGapMs),
    maxDispatchDelayMs: Math.round(trace.maxDispatchDelayMs),
    supportsCoalescedEvents: typeof event.nativeEvent.getCoalescedEvents === 'function',
  })
}

export function imagePointerSamples(event: PointerEvent<SVGSVGElement>): ImagePoint[] {
  const bounds = event.currentTarget.getBoundingClientRect()
  if (bounds.width <= 0 || bounds.height <= 0) return []
  const surface = markupSurfaceSize(bounds)
  const pointer = event.nativeEvent
  const coalesced = pointer.getCoalescedEvents?.() ?? []
  const samples = [...coalesced, pointer]
  const gesture = traces.get(event.currentTarget)
  const trace = gesture?.pointerId === event.pointerId ? gesture : undefined
  if (trace) {
    if (event.type === 'pointermove') trace.moveEvents += 1
    trace.coalescedSamples += coalesced.length
    trace.maxDispatchDelayMs = Math.max(
      trace.maxDispatchDelayMs,
      performance.now() - event.timeStamp
    )
  }
  const points: ImagePoint[] = []
  let previousSample: globalThis.PointerEvent | undefined
  for (const sample of samples) {
    if (
      previousSample &&
      sample.pointerId === previousSample.pointerId &&
      sample.timeStamp === previousSample.timeStamp &&
      sample.clientX === previousSample.clientX &&
      sample.clientY === previousSample.clientY &&
      sample.pressure === previousSample.pressure
    )
      continue
    previousSample = sample
    if (trace && sample.timeStamp > trace.previousSampleAt) {
      trace.maxSampleGapMs = Math.max(
        trace.maxSampleGapMs,
        sample.timeStamp - trace.previousSampleAt
      )
      trace.previousSampleAt = sample.timeStamp
    }
    const x = clamp((sample.clientX - bounds.left) / surface.scale, 0, surface.width)
    const y = clamp((sample.clientY - bounds.top) / surface.scale, 0, surface.height)
    if (trace?.tool === 'pen' && sample.pointerType) {
      trace.pen = measurePenSample(sample, trace.pen, (trace.width ?? 0) * surface.scale)
    }
    const pressure = trace?.pen?.pressure
    const previous = points.at(-1)
    if (previous?.x !== x || previous.y !== y || previous.pressure !== pressure) {
      points.push(pressure === undefined ? { x, y } : { x, y, pressure })
    }
  }
  if (trace) trace.deliveredPoints += points.length
  return points
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function measurePenSample(
  event: globalThis.PointerEvent,
  previous: PenSample | undefined,
  width: number
): PenSample {
  const { clientX: x, clientY: y, timeStamp: time, pointerType, pressure } = event
  const inputPressure =
    pointerType === 'pen' &&
    Number.isFinite(pressure) &&
    pressure > 0 &&
    (previous?.stylus || Math.abs(pressure - 0.5) >= 0.001)
      ? clamp(pressure, 0.08, 1)
      : null
  const stylus = previous?.stylus === true || inputPressure !== null
  if (!previous) return { x, y, time, speed: null, pressure: inputPressure ?? 0.58, stylus }
  if (x === previous.x && y === previous.y && time === previous.time && inputPressure === null)
    return previous
  const elapsed = clamp(time - previous.time, 4, 50)
  const distance = Math.hypot(x - previous.x, y - previous.y)
  const blend = (constant: number) => 1 - Math.exp(-elapsed / constant)
  const raw = distance / elapsed
  const speed =
    previous.speed === null
      ? raw
      : previous.speed + (raw - previous.speed) * blend(raw > previous.speed ? 24 : 48)
  const floor = 0.08 + 0.27 * clamp((width - 8) / 24, 0, 1)
  const desired = stylus
    ? (inputPressure ?? previous.pressure)
    : clamp(1 - Math.sqrt(clamp((speed - 0.06) / 1.54, 0, 1)), floor, 1)
  const next = clamp(
    previous.pressure +
      (desired - previous.pressure) * blend(stylus ? 18 : desired < previous.pressure ? 22 : 72),
    0.08,
    1
  )
  const limit = clamp(distance / 40, 0, 0.275)
  return {
    x,
    y,
    time,
    speed,
    stylus,
    pressure: stylus
      ? next
      : clamp(
          next,
          previous.pressure - limit,
          previous.pressure + Math.min(limit, distance / Math.max(40, 4 * width))
        ),
  }
}
