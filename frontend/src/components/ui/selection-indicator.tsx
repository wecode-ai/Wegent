// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Check, Minus } from 'lucide-react'

import { cn } from '@/lib/utils'

interface SelectionIndicatorProps {
  checked: boolean
  indeterminate?: boolean
  mixedIcon?: 'minus' | 'bar'
}

export function SelectionIndicator({
  checked,
  indeterminate = false,
  mixedIcon = 'minus',
}: SelectionIndicatorProps) {
  return (
    <span
      className={cn(
        'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border border-border bg-base text-transparent transition-colors group-hover:border-primary/70',
        checked && !indeterminate
          ? 'border-primary bg-primary text-primary-contrast shadow-sm'
          : '',
        indeterminate ? 'border-primary bg-primary/10 text-primary' : ''
      )}
    >
      {indeterminate ? (
        mixedIcon === 'bar' ? (
          <span className="h-0.5 w-2.5 rounded bg-current" />
        ) : (
          <Minus className="h-3 w-3 stroke-[2.5]" />
        )
      ) : checked ? (
        <Check className="h-3 w-3 stroke-[2.5]" />
      ) : null}
    </span>
  )
}
