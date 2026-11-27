// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Textarea as UiTextarea } from '@ui-sdk/react/textarea'
import * as React from 'react'
import { twMerge } from 'tailwind-merge'
import { controlInput } from './recipes'

export interface TextareaProps extends Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  'onSubmit'
> {
  chatStyle?: boolean
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, chatStyle = false, ...props }, ref) => (
    <UiTextarea
      className={twMerge(
        chatStyle
          ? 'flex min-h-[60px] w-full rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-text-primary ring-offset-base placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 resize-none shadow-sm'
          : twMerge(controlInput, 'flex min-h-[80px] w-full p-3 md:min-h-[80px]'),
        className
      )}
      ref={ref}
      {...props}
      value={props.value === undefined ? undefined : String(props.value)}
      defaultValue={props.defaultValue === undefined ? undefined : String(props.defaultValue)}
    />
  )
)
Textarea.displayName = 'Textarea'

export { Textarea }
