import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useRef,
  useState,
} from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { type ModelControlConfig, normalizeModelOptionValue } from '@/lib/model-ui'
import type { ModelOptions } from '@/types/api'
import styles from './ReasoningSlider.module.css'

const TRACK_EDGE_PADDING = 12
const POINTER_DRAG_THRESHOLD = 3
const ULTRA_SPARKLES = [
  { left: '9%', top: '32%', size: 2, driftX: 3, driftY: -2, delay: 0 },
  { left: '15%', top: '66%', size: 3, driftX: -2, driftY: -3, delay: 260 },
  { left: '25%', top: '23%', size: 2, driftX: 2, driftY: 3, delay: 520 },
  { left: '34%', top: '58%', size: 2, driftX: 4, driftY: -1, delay: 780 },
  { left: '45%', top: '36%', size: 3, driftX: -3, driftY: 2, delay: 1040 },
  { left: '53%', top: '70%', size: 2, driftX: 2, driftY: -3, delay: 1300 },
  { left: '63%', top: '27%', size: 2, driftX: -2, driftY: 3, delay: 1560 },
  { left: '72%', top: '61%', size: 3, driftX: 3, driftY: 2, delay: 180 },
  { left: '82%', top: '31%', size: 2, driftX: -3, driftY: -2, delay: 640 },
  { left: '90%', top: '68%', size: 2, driftX: 2, driftY: -2, delay: 1120 },
] as const

interface ReasoningSliderProps {
  control: ModelControlConfig
  selectedModelOptions: ModelOptions
  onSelectOption: (optionId: string, value: string) => void
  clearSubmenuOnHover?: boolean
  onClearSubmenu?: () => void
  onInteractionChange?: (interacting: boolean) => void
  steps?: ReasoningSliderStep[]
  selectedStepValue?: string
  onSelectStep?: (value: string) => void
}

export interface ReasoningSliderStep {
  value: string
  label: string
  dataTestId: string
  ultra?: boolean
}

function getSliderPosition(index: number, count: number): string {
  if (count <= 1) return '50%'
  if (index === 0) return '12px'
  if (index === count - 1) return 'calc(100% - 12px)'
  return `calc(12px + (100% - 24px) * ${index / (count - 1)})`
}

export function ReasoningSlider({
  control,
  selectedModelOptions,
  onSelectOption,
  clearSubmenuOnHover = true,
  onClearSubmenu,
  onInteractionChange,
  steps: providedSteps,
  selectedStepValue,
  onSelectStep,
}: ReasoningSliderProps) {
  const { t } = useTranslation('common')
  const dragActiveRef = useRef(false)
  const dragMovedRef = useRef(false)
  const dragStartXRef = useRef(0)
  const suppressClickRef = useRef(false)
  const dragValueRef = useRef<string | null>(null)
  const [interacting, setInteracting] = useState(false)
  const controlOptions = control.options.slice().sort((a, b) => a.order - b.order)
  const steps =
    providedSteps ??
    controlOptions.map(option => ({
      value: option.value,
      label: option.labelKey ? t(option.labelKey, option.label) : option.label,
      dataTestId: `model-control-${control.id}-${option.value}`,
      ultra: option.value === 'ultra',
    }))
  const requestedValue = normalizeModelOptionValue(control.id, selectedModelOptions[control.id])
  const requestedStepValue = providedSteps ? selectedStepValue : requestedValue
  const fallbackValue = providedSteps ? steps[0]?.value : control.defaultValue
  const selectedValue = steps.some(step => step.value === requestedStepValue)
    ? requestedStepValue!
    : fallbackValue
  const selectedIndex = Math.max(
    0,
    steps.findIndex(step => step.value === selectedValue)
  )

  if (steps.length === 0) return null

  const selectValue = (value: string) => {
    if (onSelectStep) {
      onSelectStep(value)
      return
    }
    onSelectOption(control.id, value)
  }

  const selectFromClientX = (track: HTMLElement, clientX: number) => {
    const rect = track.getBoundingClientRect()
    const trackStart = rect.left + TRACK_EDGE_PADDING
    const trackEnd = rect.right - TRACK_EDGE_PADDING
    const trackWidth = Math.max(1, trackEnd - trackStart)
    const ratio = Math.max(0, Math.min(1, (clientX - trackStart) / trackWidth))
    const optionIndex = steps.length === 1 ? 0 : Math.round(ratio * (steps.length - 1))
    const optionValue = steps[optionIndex]?.value
    if (!optionValue || dragValueRef.current === optionValue) return

    dragValueRef.current = optionValue
    selectValue(optionValue)
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    dragActiveRef.current = true
    dragMovedRef.current = false
    dragStartXRef.current = event.clientX
    suppressClickRef.current = false
    dragValueRef.current = null
    setInteracting(true)
    onInteractionChange?.(true)
    event.currentTarget.setPointerCapture?.(event.pointerId)
    selectFromClientX(event.currentTarget, event.clientX)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragActiveRef.current) return
    if (Math.abs(event.clientX - dragStartXRef.current) >= POINTER_DRAG_THRESHOLD) {
      dragMovedRef.current = true
      suppressClickRef.current = true
    }
    selectFromClientX(event.currentTarget, event.clientX)
  }

  const finishPointerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragActiveRef.current) return
    selectFromClientX(event.currentTarget, event.clientX)
    dragActiveRef.current = false
    dragValueRef.current = null
    setInteracting(false)
    onInteractionChange?.(false)
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    suppressClickRef.current = dragMovedRef.current
    dragMovedRef.current = false
  }

  const cancelPointerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragActiveRef.current) return
    dragActiveRef.current = false
    dragMovedRef.current = false
    suppressClickRef.current = false
    dragValueRef.current = null
    setInteracting(false)
    onInteractionChange?.(false)
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const suppressClickAfterDrag = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) return
    suppressClickRef.current = false
    event.preventDefault()
    event.stopPropagation()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? steps.length - 1
          : Math.max(
              0,
              Math.min(steps.length - 1, selectedIndex + (event.key === 'ArrowLeft' ? -1 : 1))
            )
    const nextValue = steps[nextIndex]?.value
    if (nextValue) selectValue(nextValue)
  }

  const selectedStep = steps[selectedIndex]
  const ultraSelected = selectedStep?.ultra === true
  const clearHoverSubmenu = clearSubmenuOnHover ? onClearSubmenu : undefined

  return (
    <div
      data-testid="model-control-reasoning-slider"
      data-interacting={interacting ? 'true' : 'false'}
      onMouseEnter={clearHoverSubmenu}
      onPointerEnter={clearHoverSubmenu}
      className="relative h-14 px-3"
    >
      <div
        data-testid="model-control-reasoning-track"
        role="slider"
        tabIndex={0}
        aria-valuemin={0}
        aria-valuemax={steps.length - 1}
        aria-valuenow={selectedIndex}
        aria-valuetext={selectedStep?.label}
        className="absolute inset-x-3 top-2 h-8 cursor-pointer touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointerDrag}
        onPointerCancel={cancelPointerDrag}
        onClickCapture={suppressClickAfterDrag}
        onKeyDown={handleKeyDown}
      >
        <div className="absolute inset-x-0 top-1/2 h-5 -translate-y-1/2 rounded-full bg-muted shadow-sm" />
        <div
          data-testid="model-control-reasoning-progress"
          data-ultra={ultraSelected ? 'true' : 'false'}
          className={[
            'absolute left-0 top-1/2 h-5 -translate-y-1/2 overflow-hidden rounded-full',
            ultraSelected
              ? `${styles.ultraTrack} bg-gradient-to-r from-reasoning-ultra-start to-reasoning-ultra-end`
              : 'bg-reasoning-standard',
          ].join(' ')}
          style={{ width: getSliderPosition(selectedIndex, steps.length) }}
        >
          {ultraSelected ? (
            <span data-testid="reasoning-ultra-burst" className={styles.ultraBurst} />
          ) : null}
          {ultraSelected
            ? ULTRA_SPARKLES.map((sparkle, index) => (
                <span
                  key={`${sparkle.left}-${sparkle.top}`}
                  aria-hidden="true"
                  className={`${styles.ultraSparkle} absolute rounded-full bg-reasoning-contrast/80`}
                  style={
                    {
                      left: sparkle.left,
                      top: sparkle.top,
                      width: sparkle.size,
                      height: sparkle.size,
                      animationDelay: `-${sparkle.delay}ms`,
                      '--sparkle-drift-x': `${sparkle.driftX}px`,
                      '--sparkle-drift-y': `${sparkle.driftY}px`,
                    } as CSSProperties
                  }
                  data-sparkle-index={index}
                />
              ))
            : null}
        </div>
        {steps.map((step, index) => {
          const selected = index === selectedIndex
          return (
            <button
              key={step.value}
              type="button"
              data-testid={step.dataTestId}
              aria-label={step.label}
              onFocus={clearHoverSubmenu}
              onClick={() => selectValue(step.value)}
              className="absolute top-1/2 z-10 h-8 w-8 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
              style={{ left: getSliderPosition(index, steps.length) }}
            >
              <span
                className={[
                  'absolute left-1/2 top-1/2 block -translate-x-1/2 -translate-y-1/2 rounded-full',
                  selected
                    ? 'h-6 w-6 border border-border bg-background shadow-md'
                    : index < selectedIndex
                      ? 'h-1.5 w-1.5 bg-reasoning-contrast/60'
                      : 'h-1.5 w-1.5 bg-text-muted/70',
                ].join(' ')}
              />
            </button>
          )
        })}
      </div>
    </div>
  )
}
