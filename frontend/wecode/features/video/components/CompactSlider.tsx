// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import * as React from 'react'
import * as SliderPrimitive from '@radix-ui/react-slider'

import { cn } from '@/lib/utils'

interface CompactSliderProps extends React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> {
  showValue?: boolean
  formatValue?: (value: number) => string
  trackClassName?: string
  rangeClassName?: string
  thumbClassName?: string
}

const CompactSlider = React.forwardRef<
  React.ComponentRef<typeof SliderPrimitive.Root>,
  CompactSliderProps
>(
  (
    {
      className,
      showValue = false,
      formatValue,
      trackClassName,
      rangeClassName,
      thumbClassName,
      ...props
    },
    ref
  ) => {
    const value = props.value || props.defaultValue || [0]
    const displayValue = formatValue ? formatValue(value[0]) : value[0]

    return (
      <div className="relative w-full">
        <SliderPrimitive.Root
          ref={ref}
          className={cn('relative flex w-full touch-none select-none items-center', className)}
          {...props}
        >
          <SliderPrimitive.Track
            className={cn(
              'relative h-1 w-full grow overflow-hidden rounded-full bg-muted',
              trackClassName
            )}
          >
            <SliderPrimitive.Range className={cn('absolute h-full bg-primary', rangeClassName)} />
          </SliderPrimitive.Track>
          <SliderPrimitive.Thumb
            className={cn(
              'block h-3 w-3 rounded-full border border-primary bg-white ring-offset-bg-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 cursor-pointer shadow-sm hover:shadow-md',
              thumbClassName
            )}
          />
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
CompactSlider.displayName = 'CompactSlider'

export { CompactSlider }
