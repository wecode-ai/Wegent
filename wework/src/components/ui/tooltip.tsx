import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface TooltipProps {
  label: string
  side?: 'top' | 'bottom'
  align?: 'start' | 'center' | 'end'
  testId?: string
  children: ReactNode
}

const SHOW_DELAY_MS = 700

const sidePosition = {
  top: 'bottom-full mb-2',
  bottom: 'top-full mt-2',
}

const alignPosition = {
  start: 'left-0',
  center: 'left-1/2 -translate-x-1/2',
  end: 'right-0',
}

export function Tooltip({ label, side = 'top', align = 'center', testId, children }: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const showTimerRef = useRef<number | null>(null)

  const clearShowTimer = () => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current)
      showTimerRef.current = null
    }
  }

  const scheduleShow = () => {
    clearShowTimer()
    showTimerRef.current = window.setTimeout(() => {
      setVisible(true)
      showTimerRef.current = null
    }, SHOW_DELAY_MS)
  }

  const hide = () => {
    clearShowTimer()
    setVisible(false)
  }

  useEffect(() => clearShowTimer, [])

  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === 'Escape') hide()
  }

  return (
    <span
      className="group relative inline-flex shrink-0"
      onPointerEnter={scheduleShow}
      onPointerLeave={hide}
      onFocus={scheduleShow}
      onBlur={hide}
      onClickCapture={hide}
      onKeyDown={handleKeyDown}
    >
      {children}
      <span
        role="tooltip"
        data-testid={testId}
        className={cn(
          'pointer-events-none absolute z-system-popover max-w-[20rem] whitespace-nowrap rounded-lg border border-border/70 bg-popover/95 px-2 py-1 text-sm leading-5 text-text-primary shadow-[0_10px_28px_rgba(0,0,0,0.18)] backdrop-blur-md transition-opacity duration-100',
          visible ? 'opacity-100' : 'opacity-0',
          sidePosition[side],
          alignPosition[align]
        )}
      >
        {label}
      </span>
    </span>
  )
}
