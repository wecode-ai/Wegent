import {
  notifyEmbeddedBrowserAgentCursorArrived,
  type EmbeddedBrowserAgentCursorEvent,
} from '@/lib/embedded-browser'
export const CURSOR_FADE_MS = 180
const CURSOR_CURVE_THRESHOLD = 196
const CURSOR_SPRING_DAMPING = 0.9
const CURSOR_SPRING_DURATION_MULTIPLIER = 3_000
interface CursorPoint {
  x: number
  y: number
}

export function createBrowserAgentCursorPort() {
  let currentPoint: CursorPoint | null = null
  let animationFrame: number | null = null
  let arrivalTimer: number | null = null
  let acknowledgedSequence = 0
  let visible = false
  let currentLabel: string | null = null
  let lease: symbol | null = null
  function stop() {
    if (animationFrame !== null) window.cancelAnimationFrame(animationFrame)
    if (arrivalTimer !== null) window.clearTimeout(arrivalTimer)
    animationFrame = null
    arrivalTimer = null
  }
  return {
    bind(
      element: HTMLDivElement,
      cursor: EmbeddedBrowserAgentCursorEvent | null,
      label: string,
      scale: number,
      ownsView: () => symbol | null
    ) {
      stop()
      const binding = Symbol('browser-agent-cursor')
      lease = binding
      const motionElement = element.firstElementChild
      if (!(motionElement instanceof HTMLDivElement)) return
      const ownership = ownsView()
      const isCurrent = () =>
        lease === binding && element.isConnected && ownership !== null && ownsView() === ownership
      if (currentLabel !== label) {
        currentLabel = label
        acknowledgedSequence = 0
        currentPoint = null
        visible = false
      }
      const cleanup = () => {
        if (lease !== binding) return
        lease = null
        stop()
      }
      if (!cursor || cursor.label !== label || !isCurrent()) {
        visible = false
        element.dataset.visible = 'false'
        element.style.opacity = '0'
        return cleanup
      }
      const scheduleArrival = (delayMs: number) => {
        if (cursor.moveSequence <= acknowledgedSequence) return
        arrivalTimer = window.setTimeout(() => {
          arrivalTimer = null
          if (!isCurrent()) return
          acknowledgedSequence = cursor.moveSequence
          void notifyEmbeddedBrowserAgentCursorArrived(label, cursor.moveSequence).catch(error => {
            console.error('Failed to acknowledge embedded browser agent cursor:', error)
          })
        }, delayMs)
      }
      const point: CursorPoint = {
        x: Math.max(0, cursor.x * scale),
        y: Math.max(0, cursor.y * scale),
      }

      if (!cursor.visible) {
        visible = false
        element.dataset.visible = 'false'
        element.style.opacity = '0'
        motionElement.style.transform = 'rotate(0deg) scale(1)'
        return cleanup
      }

      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
      const previous = currentPoint
      const distance = previous ? distanceBetween(previous, point) : 0
      const shouldMove =
        visible && previous !== null && cursor.animateMovement && !reducedMotion && distance >= 0.5

      visible = true
      element.dataset.visible = 'true'
      element.style.opacity = '1'

      if (!shouldMove || !previous) {
        currentPoint = point
        renderCursor(element, motionElement, point, 0, 1)
        scheduleArrival(reducedMotion ? 0 : CURSOR_FADE_MS)
        return cleanup
      }

      const curved = distance > CURSOR_CURVE_THRESHOLD
      const control = curved ? curveControlPoint(previous, point, element.parentElement) : null
      const responseSeconds = curved ? Math.min(0.34, 0.24 + distance / 4_000) : 0.22
      const durationMs = responseSeconds * CURSOR_SPRING_DURATION_MULTIPLIER
      const startedAt = performance.now()
      const animate = (now: number) => {
        if (!isCurrent()) return
        const elapsedMs = Math.max(0, now - startedAt)
        const progress = Math.min(
          1,
          springProgress(elapsedMs, responseSeconds, CURSOR_SPRING_DAMPING)
        )
        const nextPoint = control
          ? quadraticPoint(previous, control, point, progress)
          : interpolatePoint(previous, point, progress)
        const motionAmount = Math.sin(Math.min(1, progress) * Math.PI)
        const tangent = control
          ? quadraticTangent(previous, control, point, progress)
          : { x: point.x - previous.x, y: point.y - previous.y }
        const rotation = Math.max(
          -9,
          Math.min(9, (Math.atan2(tangent.y, tangent.x) * 180) / Math.PI / 8)
        )
        currentPoint = nextPoint
        renderCursor(element, motionElement, nextPoint, rotation, 1 - motionAmount * 0.12)
        if (elapsedMs >= durationMs) {
          animationFrame = null
          currentPoint = point
          renderCursor(element, motionElement, point, 0, 1)
          scheduleArrival(0)
          return
        }
        animationFrame = window.requestAnimationFrame(animate)
      }
      animationFrame = window.requestAnimationFrame(animate)

      return cleanup
    },
  }
}

function renderCursor(
  element: HTMLDivElement,
  motionElement: HTMLDivElement,
  point: CursorPoint,
  rotation: number,
  stretch: number
) {
  element.style.transform = `translate3d(${roundCursorValue(point.x - 3)}px, ${roundCursorValue(point.y - 3)}px, 0)`
  motionElement.style.transform = `rotate(${roundCursorValue(rotation)}deg) scale(${roundCursorValue(2 - stretch)}, ${roundCursorValue(stretch)})`
}

function springProgress(elapsedMs: number, responseSeconds: number, dampingFraction: number) {
  const elapsedSeconds = elapsedMs / 1_000
  const angularFrequency = (Math.PI * 2) / responseSeconds
  const dampedFrequency = angularFrequency * Math.sqrt(1 - dampingFraction ** 2)
  const envelope = Math.exp(-dampingFraction * angularFrequency * elapsedSeconds)
  const dampingRatio = dampingFraction / Math.sqrt(1 - dampingFraction ** 2)
  return (
    1 -
    envelope *
      (Math.cos(dampedFrequency * elapsedSeconds) +
        dampingRatio * Math.sin(dampedFrequency * elapsedSeconds))
  )
}

function curveControlPoint(
  start: CursorPoint,
  end: CursorPoint,
  container: HTMLElement | null
): CursorPoint {
  const distance = distanceBetween(start, end)
  const midpoint = interpolatePoint(start, end, 0.5)
  const normal = {
    x: -(end.y - start.y) / distance,
    y: (end.x - start.x) / distance,
  }
  const bend = Math.min(112, distance * 0.18)
  const direction = end.x >= start.x ? -1 : 1
  const width = container?.clientWidth ?? Number.POSITIVE_INFINITY
  const height = container?.clientHeight ?? Number.POSITIVE_INFINITY
  return {
    x: Math.max(0, Math.min(width, midpoint.x + normal.x * bend * direction)),
    y: Math.max(0, Math.min(height, midpoint.y + normal.y * bend * direction)),
  }
}

function quadraticPoint(
  start: CursorPoint,
  control: CursorPoint,
  end: CursorPoint,
  progress: number
): CursorPoint {
  const inverse = 1 - progress
  return {
    x: inverse ** 2 * start.x + 2 * inverse * progress * control.x + progress ** 2 * end.x,
    y: inverse ** 2 * start.y + 2 * inverse * progress * control.y + progress ** 2 * end.y,
  }
}

function quadraticTangent(
  start: CursorPoint,
  control: CursorPoint,
  end: CursorPoint,
  progress: number
): CursorPoint {
  return {
    x: 2 * (1 - progress) * (control.x - start.x) + 2 * progress * (end.x - control.x),
    y: 2 * (1 - progress) * (control.y - start.y) + 2 * progress * (end.y - control.y),
  }
}

function interpolatePoint(start: CursorPoint, end: CursorPoint, progress: number): CursorPoint {
  return {
    x: start.x + (end.x - start.x) * progress,
    y: start.y + (end.y - start.y) * progress,
  }
}

function distanceBetween(start: CursorPoint, end: CursorPoint) {
  return Math.hypot(end.x - start.x, end.y - start.y)
}

function roundCursorValue(value: number) {
  return Math.round(value * 1_000) / 1_000
}
