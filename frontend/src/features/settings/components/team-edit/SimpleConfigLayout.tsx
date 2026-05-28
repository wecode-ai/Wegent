// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import type { ReactNode } from 'react'

import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

interface SimpleConfigGroupProps {
  children: ReactNode
  className?: string
}

interface SimpleConfigRowProps {
  label: ReactNode
  description?: ReactNode
  children: ReactNode
  align?: 'start' | 'center'
  className?: string
}

export function SimpleConfigGroup({ children, className }: SimpleConfigGroupProps) {
  return <div className={cn('space-y-4', className)}>{children}</div>
}

export function SimpleConfigRow({
  label,
  description,
  children,
  align = 'center',
  className,
}: SimpleConfigRowProps) {
  return (
    <div
      className={cn(
        'grid gap-2 md:grid-cols-[minmax(150px,190px)_minmax(0,1fr)] md:gap-5',
        className
      )}
    >
      <div className="space-y-1">
        <Label className="text-sm font-medium text-text-primary">{label}</Label>
        {description ? <p className="text-xs leading-5 text-text-muted">{description}</p> : null}
      </div>
      <div className={cn('min-w-0', align === 'center' ? 'md:self-center' : 'md:self-start')}>
        {children}
      </div>
    </div>
  )
}
