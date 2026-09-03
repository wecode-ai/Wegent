import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react'
import { createPortal } from 'react-dom'
import {
  listenEmbeddedBrowserCloseRequests,
  notifyEmbeddedBrowserAgentCursorArrived,
  type EmbeddedBrowserAgentCursorEvent,
} from '@/lib/embedded-browser'
import { BrowserAgentCursorIcon } from './BrowserAgentCursorIcon'
import {
  claimElectronEmbeddedBrowserView,
  positionElectronEmbeddedBrowserView,
  relabelElectronEmbeddedBrowserView,
  releaseElectronEmbeddedBrowserView,
  resetElectronEmbeddedBrowserView,
  syncElectronEmbeddedBrowserView,
  type HostedElectronWebview,
} from './electronEmbeddedBrowserHost'

interface BrowserVisualRect {
  x: number
  y: number
  width: number
  height: number
}

interface ElectronEmbeddedBrowserViewProps {
  active: boolean
  interactionBlocked: boolean
  label: string
  transferFromLabel?: string
  visualRect: BrowserVisualRect | null
  cursor?: EmbeddedBrowserAgentCursorEvent | null
  cursorScale?: number
}

const CURSOR_FADE_MS = 180
const CURSOR_CURVE_THRESHOLD = 196
const CURSOR_SPRING_DAMPING = 0.9
const CURSOR_SPRING_DURATION_MULTIPLIER = 3_000

interface CursorPoint {
  x: number
  y: number
}

export function ElectronEmbeddedBrowserView({
  active,
  interactionBlocked,
  label,
  transferFromLabel,
  visualRect,
  cursor = null,
  cursorScale = 1,
}: ElectronEmbeddedBrowserViewProps) {
  const placeholderRef = useRef<HTMLDivElement | null>(null)
  const initialLabelRef = useRef(label)
  const initialTransferFromLabelRef = useRef(transferFromLabel)
  const hostRef = useRef<HostedElectronWebview | null>(null)
  const labelRef = useRef(label)
  const ownerRef = useRef(Symbol('electron-embedded-browser-view'))
  const [cursorOverlayHost, setCursorOverlayHost] = useState<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const placeholder = placeholderRef.current
    if (!placeholder) return
    const owner = ownerRef.current
    const host = claimElectronEmbeddedBrowserView(
      initialLabelRef.current,
      owner,
      initialTransferFromLabelRef.current
    )
    hostRef.current = host
    setCursorOverlayHost(host.cursorHost)

    const syncBounds = () => {
      const rect = placeholder.getBoundingClientRect()
      positionElectronEmbeddedBrowserView(host, owner, {
        height: Math.max(0, rect.height),
        left: rect.left,
        top: rect.top,
        width: Math.max(0, rect.width),
      })
    }

    syncBounds()
    const handleViewportChange = () => syncBounds()
    const resizeObserver =
      typeof ResizeObserver === 'function' ? new ResizeObserver(handleViewportChange) : null
    resizeObserver?.observe(placeholder)
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
      hostRef.current = null
      setCursorOverlayHost(null)
      releaseElectronEmbeddedBrowserView(host, owner)
    }
  }, [])

  useLayoutEffect(() => {
    labelRef.current = label
    const host = hostRef.current
    if (!host) return
    relabelElectronEmbeddedBrowserView(host, ownerRef.current, label)
  }, [label])

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    syncElectronEmbeddedBrowserView(host, ownerRef.current, active, interactionBlocked)
  }, [active, interactionBlocked])

  useEffect(() => {
    const listener = listenEmbeddedBrowserCloseRequests(event => {
      if (event.label !== labelRef.current) return
      const host = hostRef.current
      if (!host) return
      resetElectronEmbeddedBrowserView(host, ownerRef.current)
    })
    if (!listener) return undefined
    let disposed = false
    let unlisten: (() => void) | null = null
    void listener.then(nextUnlisten => {
      if (disposed) {
        nextUnlisten()
        return
      }
      unlisten = nextUnlisten
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  return (
    <>
      <div
        ref={placeholderRef}
        data-testid="workspace-browser-electron-webview-placeholder"
        className="pointer-events-none absolute overflow-hidden bg-background"
        style={{
          left: visualRect?.x ?? 0,
          top: visualRect?.y ?? 0,
          width: visualRect?.width ?? '100%',
          height: visualRect?.height ?? '100%',
        }}
      />
      {cursorOverlayHost
        ? createPortal(
            <BrowserAgentCursorOverlay cursor={cursor} label={label} scale={cursorScale} />,
            cursorOverlayHost
          )
        : null}
    </>
  )
}

function BrowserAgentCursorOverlay({
  cursor,
  label,
  scale,
}: {
  cursor: EmbeddedBrowserAgentCursorEvent | null
  label: string
  scale: number
}) {
  const cursorRef = useRef<HTMLDivElement | null>(null)
  const cursorMotionRef = useRef<HTMLDivElement | null>(null)
  const currentPointRef = useRef<CursorPoint | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const arrivalTimerRef = useRef<number | null>(null)
  const acknowledgedSequenceRef = useRef(0)
  const visibleRef = useRef(false)

  useEffect(() => {
    if (!cursor || cursor.label !== label) return
    const element = cursorRef.current
    const motionElement = cursorMotionRef.current
    if (!element || !motionElement) return
    const point: CursorPoint = {
      x: Math.max(0, cursor.x * scale),
      y: Math.max(0, cursor.y * scale),
    }
    cancelCursorAnimation(animationFrameRef)
    clearCursorArrivalTimer(arrivalTimerRef)

    if (!cursor.visible) {
      visibleRef.current = false
      element.dataset.visible = 'false'
      element.style.opacity = '0'
      motionElement.style.transform = 'rotate(0deg) scale(1)'
      return
    }

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const previous = currentPointRef.current
    const distance = previous ? distanceBetween(previous, point) : 0
    const shouldMove =
      visibleRef.current &&
      previous !== null &&
      cursor.animateMovement &&
      !reducedMotion &&
      distance >= 0.5

    visibleRef.current = true
    element.dataset.visible = 'true'
    element.style.opacity = '1'

    if (!shouldMove || !previous) {
      currentPointRef.current = point
      renderCursor(element, motionElement, point, 0, 1)
      scheduleCursorArrival(
        arrivalTimerRef,
        acknowledgedSequenceRef,
        label,
        cursor.moveSequence,
        reducedMotion ? 0 : CURSOR_FADE_MS
      )
      return
    }

    const curved = distance > CURSOR_CURVE_THRESHOLD
    const control = curved ? curveControlPoint(previous, point, element.parentElement) : null
    const responseSeconds = curved ? Math.min(0.34, 0.24 + distance / 4_000) : 0.22
    const durationMs = responseSeconds * CURSOR_SPRING_DURATION_MULTIPLIER
    const startedAt = performance.now()
    const animate = (now: number) => {
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
      currentPointRef.current = nextPoint
      renderCursor(element, motionElement, nextPoint, rotation, 1 - motionAmount * 0.12)
      if (elapsedMs >= durationMs) {
        animationFrameRef.current = null
        currentPointRef.current = point
        renderCursor(element, motionElement, point, 0, 1)
        scheduleCursorArrival(
          arrivalTimerRef,
          acknowledgedSequenceRef,
          label,
          cursor.moveSequence,
          0
        )
        return
      }
      animationFrameRef.current = window.requestAnimationFrame(animate)
    }
    animationFrameRef.current = window.requestAnimationFrame(animate)
    return () => cancelCursorAnimation(animationFrameRef)
  }, [cursor, label, scale])

  useEffect(
    () => () => {
      cancelCursorAnimation(animationFrameRef)
      clearCursorArrivalTimer(arrivalTimerRef)
    },
    []
  )

  return (
    <div
      ref={cursorRef}
      data-testid="workspace-browser-agent-cursor"
      data-visible="false"
      className="absolute left-0 top-0 h-6 w-6"
      style={{
        filter:
          'drop-shadow(0 0 6px rgb(59 130 246 / 90%)) drop-shadow(0 0 15px rgb(59 130 246 / 48%))',
        opacity: 0,
        transform: 'translate3d(-3px, -3px, 0)',
        transition: `opacity ${CURSOR_FADE_MS}ms ease`,
        willChange: 'transform, opacity',
      }}
    >
      <div ref={cursorMotionRef} className="h-6 w-6" style={{ willChange: 'transform' }}>
        <BrowserAgentCursorIcon className="h-6 w-6" />
      </div>
    </div>
  )
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

function scheduleCursorArrival(
  timerRef: MutableRefObject<number | null>,
  acknowledgedSequenceRef: MutableRefObject<number>,
  label: string,
  moveSequence: number,
  delayMs: number
) {
  if (moveSequence <= acknowledgedSequenceRef.current) return
  timerRef.current = window.setTimeout(() => {
    timerRef.current = null
    acknowledgedSequenceRef.current = moveSequence
    void notifyEmbeddedBrowserAgentCursorArrived(label, moveSequence).catch(error => {
      console.error('Failed to acknowledge embedded browser agent cursor:', error)
    })
  }, delayMs)
}

function cancelCursorAnimation(frameRef: MutableRefObject<number | null>) {
  if (frameRef.current === null) return
  window.cancelAnimationFrame(frameRef.current)
  frameRef.current = null
}

function clearCursorArrivalTimer(timerRef: MutableRefObject<number | null>) {
  if (timerRef.current === null) return
  window.clearTimeout(timerRef.current)
  timerRef.current = null
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
