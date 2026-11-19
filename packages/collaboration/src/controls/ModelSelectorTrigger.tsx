import { ChevronDown } from 'lucide-react'
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
} from 'react'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import { Button as ControlButton } from '../markdown/Button'
import { Tooltip } from "./Tooltip"

const HORIZONTAL_CHROME = 36
const LEADING_ICON_CHROME = 18

interface ModelSelectorTriggerProps {
  buttonRef: RefObject<HTMLButtonElement | null>
  onButtonChange?(element: HTMLButtonElement | null): void
  popupId?: string
  open: boolean
  disabled: boolean
  isMobile: boolean
  label: string
  leadingIcon?: ReactNode
  highlightedLabel?: string
  shortcut?: string | null
  ariaLabel: string
  tooltipLabel: string
  modelProviderId?: string
  buttonClassName?: string
  maxClosedWidth?: number
  onToggle: () => void
}

function TriggerLabel({
  label,
  highlightedLabel,
}: {
  label: string
  highlightedLabel?: string
}) {
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
  onButtonChange,
  popupId,
  open,
  disabled,
  isMobile,
  label,
  leadingIcon,
  highlightedLabel,
  shortcut,
  ariaLabel,
  tooltipLabel,
  modelProviderId,
  buttonClassName,
  maxClosedWidth = Infinity,
  onToggle,
}: ModelSelectorTriggerProps) {
  const setButton = useCallback(
    (element: HTMLButtonElement | null) => {
      buttonRef.current = element
      onButtonChange?.(element)
    },
    [buttonRef, onButtonChange],
  )
  const measureRef = useRef<HTMLSpanElement>(null)
  const hasLeadingIcon = Boolean(leadingIcon)

  useLayoutEffect(() => {
    const button = buttonRef.current
    if (isMobile || !button) return
    const updateWidth = () => {
      const measuredWidth = Math.max(
        measureRef.current?.getBoundingClientRect().width ?? 0,
        measureRef.current?.scrollWidth ?? 0,
      )
      if (measuredWidth <= 0) return
      const naturalWidth =
        Math.ceil(measuredWidth) +
        HORIZONTAL_CHROME +
        (hasLeadingIcon ? LEADING_ICON_CHROME : 0)
      button.style.setProperty(
        '--model-selector-width',
        `${Math.max(64, Math.min(maxClosedWidth, naturalWidth))}px`,
      )
    }

    updateWidth()
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(updateWidth)
    if (measureRef.current) observer?.observe(measureRef.current)
    void document.fonts?.ready.then(updateWidth)
    window.addEventListener('resize', updateWidth)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateWidth)
    }
  }, [buttonRef, hasLeadingIcon, isMobile, label, maxClosedWidth])

  const desktopStyle: CSSProperties | undefined = isMobile
    ? undefined
    : {
        width: 'var(--model-selector-width, auto)',
      }

  return (
    <>
      <Tooltip
        label={tooltipLabel}
        shortcut={shortcut ?? undefined}
        disabled={isMobile || open || disabled}
        testId="model-selector-tooltip"
      >
        <ControlButton
          variant="unstyled"
          ref={setButton}
          type="button"
          data-testid="model-selector-button"
          data-model-provider-id={modelProviderId}
          onClick={onToggle}
          disabled={disabled}
          style={desktopStyle}
          className={cn(
            'flex h-11 min-w-11 max-w-full items-center gap-1 overflow-hidden rounded-full px-2 text-sm font-normal leading-[18px] text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 md:h-8 md:min-w-8',
            !isMobile &&
              'transition-[width,background-color,color,opacity] duration-200 [transition-timing-function:cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none',
            buttonClassName,
          )}
          aria-haspopup="dialog"
          aria-controls={open ? popupId : undefined}
          aria-expanded={open}
          aria-label={ariaLabel}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1">
            {leadingIcon}
            <span className="min-w-0 truncate">
              <TriggerLabel label={label} highlightedLabel={highlightedLabel} />
            </span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-text-secondary" />
        </ControlButton>
      </Tooltip>
      {!isMobile ? (
        <span
          ref={measureRef}
          aria-hidden="true"
          data-testid="model-selector-width-measure"
          className="pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap text-sm font-normal leading-[18px]"
        >
          {label}
        </span>
      ) : null}
    </>
  )
}
