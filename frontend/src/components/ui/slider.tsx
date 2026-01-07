// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import * as React from 'react'
import * as SliderPrimitive from '@radix-ui/react-slider'

import { cn } from '@/lib/utils'

interface SliderProps extends React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> {
  showValue?: boolean
  formatValue?: (value: number) => string
}

const Slider = React.forwardRef<React.ElementRef<typeof SliderPrimitive.Root>, SliderProps>(
  ({ className, showValue = false, formatValue, ...props }, ref) => {
    const value = props.value || props.defaultValue || [0]
    const displayValue = formatValue ? formatValue(value[0]) : value[0]

    return (
      <div className="relative w-full">
        <SliderPrimitive.Root
          ref={ref}
          className={cn('relative flex w-full touch-none select-none items-center', className)}
          {...props}
        >
          <SliderPrimitive.Track className="relative h-2 w-full grow overflow-hidden rounded-full bg-muted">
            <SliderPrimitive.Range className="absolute h-full bg-primary" />
          </SliderPrimitive.Track>
          <SliderPrimitive.Thumb className="block h-5 w-5 rounded-full border-2 border-primary bg-bg-base ring-offset-bg-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 cursor-pointer hover:bg-bg-surface" />
        </SliderPrimitive.Root>
        {showValue && (
          <div className="absolute -top-6 right-0 text-sm text-text-secondary font-medium">
            {displayValue}
          </div>
        )}
      </div>
    )
  }
)
Slider.displayName = SliderPrimitive.Root.displayName

// Dual-value slider for weight distribution (e.g., semantic vs keyword weight)
interface DualWeightSliderProps {
  value: number // 0-1, represents the first weight (second weight = 1 - value)
  onChange: (value: number) => void
  leftLabel: string
  rightLabel: string
  disabled?: boolean
  className?: string
}

const DualWeightSlider = React.forwardRef<HTMLDivElement, DualWeightSliderProps>(
  ({ value, onChange, leftLabel, rightLabel, disabled = false, className }, ref) => {
    const leftWeight = value
    const rightWeight = Math.round((1 - value) * 100) / 100

    return (
      <div ref={ref} className={cn('space-y-3', className)}>
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-secondary">{leftLabel}</span>
          <span className="text-text-secondary">{rightLabel}</span>
        </div>
        <SliderPrimitive.Root
          className="relative flex w-full touch-none select-none items-center"
          value={[value]}
          onValueChange={values => onChange(values[0])}
          min={0}
          max={1}
          step={0.05}
          disabled={disabled}
        >
          <SliderPrimitive.Track className="relative h-2 w-full grow overflow-hidden rounded-full bg-muted">
            <SliderPrimitive.Range className="absolute h-full bg-primary" />
          </SliderPrimitive.Track>
          <SliderPrimitive.Thumb className="block h-5 w-5 rounded-full border-2 border-primary bg-bg-base ring-offset-bg-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 cursor-pointer hover:bg-bg-surface" />
        </SliderPrimitive.Root>
        <div className="flex items-center justify-between text-sm font-medium">
          <span className="text-primary">{leftWeight.toFixed(2)}</span>
          <span className="text-text-muted">{rightWeight.toFixed(2)}</span>
        </div>
      </div>
    )
  }
)
DualWeightSlider.displayName = 'DualWeightSlider'

export { Slider, DualWeightSlider }
