// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react'

import { ResourceCardFooter } from '@/components/common/ResourceCardFooter'
import { cn } from '@/lib/utils'

interface ManagedResourceCardFooterProps {
  owner?: string | null
  updatedAt?: string | null
  leading?: ReactNode
  actions?: ReactNode
  actionsClassName?: string
  className?: string
  testId?: string
}

export function ManagedResourceCardFooter({
  owner,
  updatedAt,
  leading,
  actions,
  actionsClassName,
  className,
  testId,
}: ManagedResourceCardFooterProps) {
  const hasMetadata = Boolean(owner?.trim() || updatedAt)

  return (
    <div className={cn('mt-auto border-t border-border/70 pt-3', className)} data-testid={testId}>
      <ResourceCardFooter owner={owner} updatedAt={updatedAt} className="mt-0" />
      {(leading || actions) && (
        <div
          className={cn(
            'flex min-w-0 flex-wrap items-center justify-between gap-1.5',
            hasMetadata && 'mt-3'
          )}
        >
          {leading && <div className="flex min-w-0 items-center gap-1.5">{leading}</div>}
          {actions && (
            <div
              className={cn(
                'ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5',
                actionsClassName
              )}
            >
              {actions}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
