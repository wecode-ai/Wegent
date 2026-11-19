import type { ModelOptions } from '@wegent/chat-core/models'
import type { CollaborationTranslate } from '../i18n'
import { Button } from '../markdown/Button'
import { type ModelControlConfig, normalizeModelOptionValue } from './model-ui'
import { RangeSlider } from './RangeSlider'
import styles from './ReasoningSlider.module.css'

interface ReasoningSliderProps {
  translate: CollaborationTranslate
  control: ModelControlConfig
  selectedModelOptions: ModelOptions
  onSelectOption: (optionId: string, value: string) => void
  compact?: boolean
  clearSubmenuOnHover?: boolean
  onClearSubmenu?: () => void
  onInteractionChange?: (interacting: boolean) => void
  steps?: ReasoningSliderStep[]
  selectedStepValue?: string
  onSelectStep?: (value: string) => void
  accentPulse?: boolean
  describedBy?: string
}

export interface ReasoningSliderStep {
  value: string
  label: string
  dataTestId: string
  ultra?: boolean
}

export function ReasoningSlider({
  translate: t,
  control,
  selectedModelOptions,
  onSelectOption,
  compact = false,
  clearSubmenuOnHover = true,
  onClearSubmenu,
  onInteractionChange,
  steps: providedSteps,
  selectedStepValue,
  onSelectStep,
  accentPulse = false,
  describedBy,
}: ReasoningSliderProps) {
  const steps =
    providedSteps ??
    [...control.options]
      .sort((a, b) => a.order - b.order)
      .map(option => ({
        value: option.value,
        label: option.labelKey ? t(option.labelKey, option.label) : option.label,
        dataTestId: 'model-control-' + control.id + '-' + option.value,
        ultra: option.value === 'ultra',
      }))
  const requested = providedSteps
    ? selectedStepValue
    : normalizeModelOptionValue(control.id, selectedModelOptions[control.id])
  const selected = steps.findIndex(step => step.value === requested)
  const fallback = steps.findIndex(step => step.value === control.defaultValue)
  const index = selected >= 0 ? selected : Math.max(0, fallback)
  if (!steps.length) return null
  const current = steps[index]
  const choose = (value: string) => {
    if (onSelectStep) onSelectStep(value)
    else onSelectOption(control.id, value)
  }
  const clear = clearSubmenuOnHover ? onClearSubmenu : undefined
  return (
    <div
      onMouseEnter={clear}
      onPointerEnter={clear}
      className={compact ? 'relative h-12 md:h-9' : 'relative h-12 md:h-10'}
    >
      <RangeSlider
        testId="model-control-reasoning-slider"
        inputTestId="model-control-reasoning-track"
        thumbTestId="model-control-reasoning-thumb"
        progressTestId="model-control-reasoning-progress"
        describedBy={describedBy}
        label={control.labelKey ? t(control.labelKey, control.label) : control.label}
        value={index}
        max={Math.max(1, steps.length - 1)}
        disabled={steps.length < 2}
        valueText={current.label}
        onChange={next => {
          const step = steps[next]
          if (step) choose(step.value)
        }}
        onInteractionChange={onInteractionChange}
        progressClassName={
          current.ultra
            ? 'bg-gradient-to-r from-reasoning-ultra-start to-reasoning-ultra-end'
            : 'bg-reasoning-standard'
        }
        progressContent={
          <>
            {accentPulse && <span aria-hidden="true" className={styles.accentPulse} />}
            {current.ultra && (
              <span
                aria-hidden="true"
                data-testid="reasoning-ultra-burst"
                className={styles.ultraBurst}
              />
            )}
          </>
        }
      >
        {steps.map((step, position) => (
          <Button
            key={step.value}
            variant="ghost"
            size="icon"
            data-testid={step.dataTestId}
            aria-label={step.label}
            onFocus={clear}
            onClick={() => choose(step.value)}
            style={{ left: steps.length < 2 ? '50%' : (position / (steps.length - 1)) * 100 + '%' }}
            className="absolute top-1/2 z-10 h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
          >
            <span
              aria-hidden="true"
              className={
                position === index
                  ? 'h-1.5 w-1.5 rounded-full bg-transparent'
                  : position < index
                    ? 'h-1.5 w-1.5 rounded-full bg-reasoning-contrast/60'
                    : 'h-1.5 w-1.5 rounded-full bg-text-muted/70'
              }
            />
          </Button>
        ))}
      </RangeSlider>
    </div>
  )
}
