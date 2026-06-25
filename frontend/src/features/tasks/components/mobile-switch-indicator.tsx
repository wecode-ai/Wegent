// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { cn } from '@/lib/utils'

interface MobileSwitchIndicatorProps {
  checked: boolean
  disabled?: boolean
  className?: string
}

export function MobileSwitchIndicator({
  checked,
  disabled = false,
  className,
}: MobileSwitchIndicatorProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'pointer-events-none inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent shadow-sm transition-colors',
        checked ? 'bg-primary' : 'bg-border',
        disabled && 'opacity-50',
        className
      )}
    >
      <span
        className={cn(
          'block h-4 w-4 rounded-full bg-base shadow-lg ring-0 transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0'
        )}
      />
    </span>
  )
}
