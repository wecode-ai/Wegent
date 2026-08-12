import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

interface TooltipProps {
  label: string
  side?: 'top' | 'bottom'
  align?: 'start' | 'center' | 'end'
  testId?: string
  className?: string
  children: ReactNode
}

const SHOW_DELAY_MS = 700
const VIEWPORT_PADDING_PX = 8
const TRIGGER_GAP_PX = 8

export function Tooltip({
  label,
  side = 'top',
  align = 'center',
  testId,
  className,
  children,
}: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const [position, setPosition] = useState<CSSProperties>()
  const showTimerRef = useRef<number | null>(null)
  const triggerRef = useRef<HTMLSpanElement>(null)
  const tooltipRef = useRef<HTMLSpanElement>(null)

  const clearShowTimer = useCallback(() => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current)
      showTimerRef.current = null
    }
  }, [])

  const scheduleShow = () => {
    clearShowTimer()
    showTimerRef.current = window.setTimeout(() => {
      setVisible(true)
      showTimerRef.current = null
    }, SHOW_DELAY_MS)
  }

  const hide = useCallback(() => {
    clearShowTimer()
    setVisible(false)
  }, [clearShowTimer])

  useEffect(() => clearShowTimer, [clearShowTimer])

  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === 'Escape') hide()
  }

  useLayoutEffect(() => {
    if (!visible || !triggerRef.current || !tooltipRef.current) return

    const triggerRect = triggerRef.current.getBoundingClientRect()
    const tooltipRect = tooltipRef.current.getBoundingClientRect()
    const preferredTop =
      side === 'top'
        ? triggerRect.top - tooltipRect.height - TRIGGER_GAP_PX
        : triggerRect.bottom + TRIGGER_GAP_PX
    const alternateTop =
      side === 'top'
        ? triggerRect.bottom + TRIGGER_GAP_PX
        : triggerRect.top - tooltipRect.height - TRIGGER_GAP_PX
    const selectedTop =
      preferredTop >= VIEWPORT_PADDING_PX &&
      preferredTop + tooltipRect.height <= window.innerHeight - VIEWPORT_PADDING_PX
        ? preferredTop
        : alternateTop
    const top = Math.min(
      Math.max(selectedTop, VIEWPORT_PADDING_PX),
      window.innerHeight - tooltipRect.height - VIEWPORT_PADDING_PX
    )

    const alignedLeft =
      align === 'start'
        ? triggerRect.left
        : align === 'end'
          ? triggerRect.right - tooltipRect.width
          : triggerRect.left + (triggerRect.width - tooltipRect.width) / 2
    const left = Math.min(
      Math.max(alignedLeft, VIEWPORT_PADDING_PX),
      window.innerWidth - tooltipRect.width - VIEWPORT_PADDING_PX
    )

    setPosition({ left, top })
  }, [align, side, visible])

  useEffect(() => {
    if (!visible) return
    const hideOnViewportChange = () => hide()
    window.addEventListener('resize', hideOnViewportChange)
    window.addEventListener('scroll', hideOnViewportChange, true)
    return () => {
      window.removeEventListener('resize', hideOnViewportChange)
      window.removeEventListener('scroll', hideOnViewportChange, true)
    }
  }, [hide, visible])

  return (
    <span
      ref={triggerRef}
      className={cn('group relative inline-flex shrink-0', className)}
      onPointerEnter={scheduleShow}
      onPointerLeave={hide}
      onFocus={scheduleShow}
      onBlur={hide}
      onClickCapture={hide}
      onKeyDown={handleKeyDown}
    >
      {children}
      {visible
        ? createPortal(
            <span
              ref={tooltipRef}
              role="tooltip"
              data-testid={testId}
              style={position}
              className={cn(
                'pointer-events-none fixed z-system-popover max-w-[20rem] whitespace-nowrap rounded-lg border border-border/70 bg-popover/95 px-2 py-1 text-sm leading-5 text-text-primary shadow-[0_10px_28px_rgba(0,0,0,0.18)] backdrop-blur-md',
                position ? 'opacity-100' : 'opacity-0'
              )}
            >
              {label}
            </span>,
            document.body
          )
        : null}
    </span>
  )
}
