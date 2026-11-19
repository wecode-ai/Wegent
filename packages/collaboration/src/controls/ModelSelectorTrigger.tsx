import { ChevronDown } from 'lucide-react'
import { type ReactNode, type RefObject, useCallback } from 'react'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import { Button as ControlButton } from '../markdown/Button'
import { Tooltip } from './Tooltip'

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
  maxClosedWidth,
  onToggle,
}: ModelSelectorTriggerProps) {
  const setButton = useCallback(
    (element: HTMLButtonElement | null) => {
      buttonRef.current = element
      onButtonChange?.(element)
    },
    [buttonRef, onButtonChange]
  )
  return (
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
        style={
          maxClosedWidth === undefined ? undefined : { maxWidth: `min(100%, ${maxClosedWidth}px)` }
        }
        className={cn(
          'flex h-11 min-w-11 max-w-full items-center gap-1 overflow-hidden rounded-full px-2 text-sm font-normal leading-[18px] text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 md:h-8 md:min-w-8',
          !isMobile &&
            'transition-[background-color,color,opacity] duration-200 [transition-timing-function:cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none',
          buttonClassName
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
  )
}
