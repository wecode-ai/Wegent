import { createPortal } from 'react-dom'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'

const SHOW_DELAY_MS = 700
const VIEWPORT_PADDING_PX = 8
const TRIGGER_GAP_PX = 8

interface TooltipTarget {
  button: HTMLButtonElement
  label: string
}

export function GlobalIconButtonTooltip() {
  const [target, setTarget] = useState<TooltipTarget | null>(null)
  const [visible, setVisible] = useState(false)
  const [position, setPosition] = useState<CSSProperties>()
  const showTimerRef = useRef<number | null>(null)
  const tooltipRef = useRef<HTMLSpanElement>(null)

  const hide = useCallback(() => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current)
      showTimerRef.current = null
    }
    setVisible(false)
    setTarget(null)
    setPosition(undefined)
  }, [])

  const schedule = useCallback(
    (button: HTMLButtonElement) => {
      const label = button.getAttribute('aria-label')?.trim()
      if (!label || button.closest('[data-tooltip-trigger]')) {
        hide()
        return
      }
      if (showTimerRef.current !== null) window.clearTimeout(showTimerRef.current)
      setTarget({ button, label })
      setVisible(false)
      setPosition(undefined)
      showTimerRef.current = window.setTimeout(() => {
        setVisible(true)
        showTimerRef.current = null
      }, SHOW_DELAY_MS)
    },
    [hide]
  )

  useEffect(() => {
    const buttonFromTarget = (eventTarget: EventTarget | null) =>
      eventTarget instanceof Element
        ? eventTarget.closest<HTMLButtonElement>('button[aria-label]')
        : null
    const handlePointerOver = (event: PointerEvent) => {
      const button = buttonFromTarget(event.target)
      if (button) schedule(button)
    }
    const handlePointerOut = (event: PointerEvent) => {
      const button = buttonFromTarget(event.target)
      if (
        !button ||
        (event.relatedTarget instanceof Node && button.contains(event.relatedTarget))
      ) {
        return
      }
      hide()
    }
    const handleFocusIn = (event: FocusEvent) => {
      const button = buttonFromTarget(event.target)
      if (button) schedule(button)
    }
    const handleFocusOut = (event: FocusEvent) => {
      const button = buttonFromTarget(event.target)
      if (
        !button ||
        (event.relatedTarget instanceof Node && button.contains(event.relatedTarget))
      ) {
        return
      }
      hide()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide()
    }

    document.addEventListener('pointerover', handlePointerOver)
    document.addEventListener('pointerout', handlePointerOut)
    document.addEventListener('focusin', handleFocusIn)
    document.addEventListener('focusout', handleFocusOut)
    document.addEventListener('click', hide, true)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', hide)
    window.addEventListener('scroll', hide, true)
    return () => {
      if (showTimerRef.current !== null) window.clearTimeout(showTimerRef.current)
      document.removeEventListener('pointerover', handlePointerOver)
      document.removeEventListener('pointerout', handlePointerOut)
      document.removeEventListener('focusin', handleFocusIn)
      document.removeEventListener('focusout', handleFocusOut)
      document.removeEventListener('click', hide, true)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', hide)
      window.removeEventListener('scroll', hide, true)
    }
  }, [hide, schedule])

  useLayoutEffect(() => {
    if (!visible || !target || !tooltipRef.current) return

    const triggerRect = target.button.getBoundingClientRect()
    const tooltipRect = tooltipRef.current.getBoundingClientRect()
    const preferredTop = triggerRect.bottom + TRIGGER_GAP_PX
    const alternateTop = triggerRect.top - tooltipRect.height - TRIGGER_GAP_PX
    const top =
      preferredTop + tooltipRect.height <= window.innerHeight - VIEWPORT_PADDING_PX
        ? preferredTop
        : Math.max(VIEWPORT_PADDING_PX, alternateTop)
    const centeredLeft = triggerRect.left + (triggerRect.width - tooltipRect.width) / 2
    const left = Math.min(
      Math.max(centeredLeft, VIEWPORT_PADDING_PX),
      window.innerWidth - tooltipRect.width - VIEWPORT_PADDING_PX
    )

    setPosition({ left, top })
  }, [target, visible])

  if (!visible || !target) return null

  return createPortal(
    <span
      ref={tooltipRef}
      role="tooltip"
      style={position}
      className={`pointer-events-none fixed z-system-popover max-w-[20rem] whitespace-normal break-words rounded-lg border border-border/70 bg-popover/95 px-2 py-1 text-sm leading-5 text-text-primary shadow-[0_10px_28px_rgba(0,0,0,0.18)] backdrop-blur-md ${
        position ? 'opacity-100' : 'opacity-0'
      }`}
    >
      {target.label}
    </span>,
    document.body
  )
}
