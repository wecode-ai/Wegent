// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

interface ResourceManagementLayoutProps {
  title: string
  description?: string
  actions?: ReactNode
  filters?: ReactNode
  children: ReactNode
  className?: string
  titleTestId?: string
  'data-testid'?: string
}

export function ResourceManagementLayout({
  title,
  description,
  actions,
  filters,
  children,
  className,
  titleTestId,
  'data-testid': testId,
}: ResourceManagementLayoutProps) {
  return (
    <section className={cn('space-y-4', className)} data-testid={testId}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="mb-1 text-xl font-semibold text-text-primary" data-testid={titleTestId}>
            {title}
          </h2>
          {description && <p className="text-sm text-text-muted">{description}</p>}
        </div>
        {actions && (
          <div
            className="flex flex-wrap items-center gap-2 sm:justify-end"
            data-testid="resource-page-header-actions"
          >
            {actions}
          </div>
        )}
      </div>

      {filters && (
        <div className="flex flex-col gap-3" data-testid="resource-page-filter-bar">
          {filters}
        </div>
      )}

      {children}
    </section>
  )
}
