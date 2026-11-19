import { slider } from '@ui-sdk/core/slider'
import { usePart } from '@ui-sdk/react/primitive'
import { Slider, SliderControl, SliderIndicator, SliderTrack } from '@ui-sdk/react/slider'
import type { ComponentProps, ReactNode } from 'react'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'

function SliderThumb({
  testId,
  inputTestId,
  label,
  describedBy,
  value,
  min,
  max,
}: {
  testId?: string
  inputTestId: string
  label: string
  describedBy?: string
  value: number
  min: number
  max: number
}) {
  const inputProps: ComponentProps<'input'> & { 'data-testid': string } = {
    'data-testid': inputTestId,
    role: 'slider',
    'aria-valuenow': value,
    'aria-valuemin': min,
    'aria-valuemax': max,
    'aria-label': label,
    'aria-describedby': describedBy,
  }
  const input = usePart(slider, 'thumb-input', { index: 0 }, inputProps, 'input')
  const thumbProps = {
    'data-testid': testId,
    className:
      'z-20 h-7 w-7 rounded-full border border-border bg-background shadow-sm has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus',
    children: input,
  }
  return usePart(slider, 'thumb', { index: 0 }, thumbProps, 'span')
}

export interface RangeSliderProps {
  value: number
  min?: number
  max: number
  step?: number
  disabled?: boolean
  label: string
  testId: string
  inputTestId?: string
  thumbTestId?: string
  progressTestId?: string
  describedBy?: string
  valueText?: string
  onChange(value: number): void
  onInteractionChange?(active: boolean): void
  className?: string
  progressClassName?: string
  children?: ReactNode
  progressContent?: ReactNode
}

export function RangeSlider({
  value,
  min = 0,
  max,
  step = 1,
  disabled,
  label,
  testId,
  inputTestId = `${testId}-input`,
  thumbTestId,
  progressTestId,
  describedBy,
  valueText,
  onChange,
  onInteractionChange,
  className,
  progressClassName,
  children,
  progressContent,
}: RangeSliderProps) {
  return (
    <Slider
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      format={valueText ? () => valueText : undefined}
      data-testid={inputTestId === testId ? testId + '-control' : testId}
      className={className}
      onValueChange={(next, details) => {
        if (details.reason === 'drag' || details.reason === 'track-press')
          onInteractionChange?.(true)
        onChange(next)
      }}
      onValueCommit={() => onInteractionChange?.(false)}
    >
      <SliderControl className="relative flex h-11 touch-none items-center px-3 md:h-8">
        <SliderTrack className="relative h-6 w-full rounded-full bg-muted">
          <SliderIndicator
            data-testid={progressTestId}
            className={cn(
              'absolute h-full overflow-hidden rounded-full bg-focus',
              progressClassName
            )}
          >
            {progressContent}
          </SliderIndicator>
          {children}
          <SliderThumb
            testId={thumbTestId}
            inputTestId={inputTestId}
            label={label}
            describedBy={describedBy}
            value={value}
            min={min}
            max={max}
          />
        </SliderTrack>
      </SliderControl>
    </Slider>
  )
}
