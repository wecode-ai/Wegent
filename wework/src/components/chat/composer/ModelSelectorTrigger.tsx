import { ChevronDown } from 'lucide-react'
import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { KeyboardShortcut } from '@/components/common/KeyboardShortcut'
import { cn } from '@/lib/utils'

const OPEN_WIDTH = 240
const CLOSED_MAX_WIDTH = 208
const HORIZONTAL_CHROME = 36

interface ModelSelectorTriggerProps {
  buttonRef: RefObject<HTMLButtonElement | null>
  open: boolean
  disabled: boolean
  isMobile: boolean
  label: string
  highlightedLabel?: string
  shortcut?: string | null
  ariaLabel: string
  tooltipLabel: string
  buttonClassName?: string
  onToggle: () => void
}

function TriggerLabel({ label, highlightedLabel }: { label: string; highlightedLabel?: string }) {
  if (!highlightedLabel) return label
  const highlightIndex = label.lastIndexOf(highlightedLabel)
  if (highlightIndex < 0) return label
  return (
    <>
      {label.slice(0, highlightIndex)}
      <span className="text-reasoning-ultra-text">{highlightedLabel}</span>
      {label.slice(highlightIndex + highlightedLabel.length)}
    </>
  )
}

export function ModelSelectorTrigger({
  buttonRef,
  open,
  disabled,
  isMobile,
  label,
  highlightedLabel,
  shortcut,
  ariaLabel,
  tooltipLabel,
  buttonClassName,
  onToggle,
}: ModelSelectorTriggerProps) {
  const measureRef = useRef<HTMLSpanElement>(null)
  const previousOpenRef = useRef(open)
  const [tooltipSuppressed, setTooltipSuppressed] = useState(false)

  useEffect(() => {
    if (previousOpenRef.current && !open) {
      setTooltipSuppressed(true)
    }
    previousOpenRef.current = open
  }, [open])

  useLayoutEffect(() => {
    const button = buttonRef.current
    if (isMobile || !button) return
    const updateWidth = () => {
      const measuredWidth = Math.max(
        measureRef.current?.getBoundingClientRect().width ?? 0,
        measureRef.current?.scrollWidth ?? 0
      )
      if (measuredWidth <= 0) return
      const naturalWidth = Math.ceil(measuredWidth) + HORIZONTAL_CHROME
      button.style.setProperty(
        '--model-selector-closed-width',
        `${Math.max(64, Math.min(CLOSED_MAX_WIDTH, naturalWidth))}px`
      )
    }

    updateWidth()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateWidth)
    if (measureRef.current) observer?.observe(measureRef.current)
    void document.fonts?.ready.then(updateWidth)
    window.addEventListener('resize', updateWidth)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateWidth)
    }
  }, [buttonRef, isMobile, label])

  const desktopStyle: CSSProperties | undefined = isMobile
    ? undefined
    : {
        width: open ? OPEN_WIDTH : 'var(--model-selector-closed-width, auto)',
      }
  const showTooltip = !isMobile && !open && !tooltipSuppressed

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid="model-selector-button"
        onClick={onToggle}
        onPointerEnter={() => {
          if (!open && tooltipSuppressed) setTooltipSuppressed(false)
        }}
        disabled={disabled}
        style={desktopStyle}
        className={cn(
          'flex h-8 min-w-8 items-center gap-1 overflow-hidden rounded-full px-2 text-[13px] font-light leading-[18px] text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50',
          !isMobile &&
            'transition-[width,background-color,color,opacity] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none',
          buttonClassName
        )}
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-describedby={showTooltip ? 'model-selector-tooltip' : undefined}
      >
        <span className="min-w-0 flex-1 truncate text-center">
          <TriggerLabel label={label} highlightedLabel={highlightedLabel} />
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-text-secondary" />
      </button>
      {!isMobile ? (
        <span
          ref={measureRef}
          aria-hidden="true"
          className="pointer-events-none invisible absolute whitespace-nowrap text-[13px] font-light leading-[18px]"
        >
          {label}
        </span>
      ) : null}
      {showTooltip ? (
        <span
          id="model-selector-tooltip"
          role="tooltip"
          data-testid="model-selector-tooltip"
          className="pointer-events-none absolute bottom-[calc(100%+0.5rem)] right-0 z-system-popover flex h-9 items-center gap-2 whitespace-nowrap rounded-xl border border-border bg-popover px-3 text-[13px] font-medium leading-[18px] text-text-primary opacity-0 shadow-[0_10px_28px_rgba(0,0,0,0.18)] transition-opacity delay-0 duration-150 group-hover/model-selector:delay-[1500ms] group-hover/model-selector:opacity-100"
        >
          <span>{tooltipLabel}</span>
          {shortcut ? (
            <KeyboardShortcut value={shortcut} className="h-6 bg-muted px-2 text-text-secondary" />
          ) : null}
        </span>
      ) : null}
    </>
  )
}
