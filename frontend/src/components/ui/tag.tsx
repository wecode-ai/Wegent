// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { X } from 'lucide-react'

import { cn } from '@/lib/utils'

const tagVariants = cva(
  'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'border-border bg-surface text-text-primary',
        success: 'border-success/20 bg-success/10 text-success',
        error: 'border-error/20 bg-error/10 text-error',
        warning: 'border-warning/20 bg-warning/10 text-warning',
        info: 'border-primary/20 bg-primary/10 text-primary',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

export interface TagProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof tagVariants> {
  closable?: boolean
  onClose?: () => void
}

function Tag({ className, variant, closable, onClose, children, ...props }: TagProps) {
  return (
    <span className={cn(tagVariants({ variant }), className)} {...props}>
      {children}
      {closable && (
        <button
          onClick={onClose}
          className="ml-0.5 rounded-sm hover:bg-border/20 transition-colors"
          type="button"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  )
}

export { Tag, tagVariants }
