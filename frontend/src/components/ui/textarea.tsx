// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import * as React from 'react'

import { cn } from '@/lib/utils'

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  chatStyle?: boolean
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, chatStyle = false, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          chatStyle
            ? 'flex min-h-[60px] w-full rounded-2xl border border-border bg-surface px-4 py-3 text-sm ring-offset-base placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 resize-none shadow-sm'
            : 'flex min-h-[80px] w-full rounded-lg border border-border bg-surface px-4 py-3 text-sm ring-offset-base placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Textarea.displayName = 'Textarea'

export { Textarea }
