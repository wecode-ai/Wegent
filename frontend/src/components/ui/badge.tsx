// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center justify-center rounded-full text-xs font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-contrast',
        success: 'bg-success text-white',
        error: 'bg-error text-white',
        warning: 'bg-warning text-white',
        info: 'bg-blue-500/10 text-blue-600 border border-blue-500/20',
        secondary: 'bg-muted text-text-secondary',
      },
      size: {
        default: 'h-5 px-2',
        sm: 'h-4 px-1.5 text-[10px]',
        lg: 'h-6 px-3',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, size }), className)} {...props} />
}

export { Badge, badgeVariants }
