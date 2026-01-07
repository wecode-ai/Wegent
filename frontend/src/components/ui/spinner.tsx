// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const spinnerVariants = cva(
  'inline-block animate-spin rounded-full border-2 border-solid border-transparent border-t-current align-[-0.125em] motion-reduce:animate-[spin_1.5s_linear_infinite]',
  {
    variants: {
      size: {
        sm: 'h-4 w-4 border-2',
        md: 'h-6 w-6 border-2',
        lg: 'h-8 w-8 border-[3px]',
      },
    },
    defaultVariants: {
      size: 'md',
    },
  }
)

export interface SpinnerProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof spinnerVariants> {
  text?: string
  center?: boolean
}

const Spinner = React.forwardRef<HTMLDivElement, SpinnerProps>(
  ({ className, size, text, center = false, ...props }, ref) => {
    const spinner = (
      <div
        ref={ref}
        role="status"
        aria-label="Loading"
        className={cn(
          center && 'flex items-center justify-center',
          !center && 'inline-flex items-center gap-2',
          className
        )}
        {...props}
      >
        <div className={cn(spinnerVariants({ size }))} />
        {text && <span className="text-sm text-text-muted">{text}</span>}
        <span className="sr-only">Loading...</span>
      </div>
    )

    if (center) {
      return <div className="flex min-h-[200px] w-full items-center justify-center">{spinner}</div>
    }

    return spinner
  }
)
Spinner.displayName = 'Spinner'

export { Spinner, spinnerVariants }
