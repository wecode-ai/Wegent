// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { format } from 'date-fns'

import { cn } from '@/lib/utils'

interface ResourceCardFooterProps {
  owner?: string | null
  updatedAt?: string | null
  className?: string
  testId?: string
}

export function ResourceCardFooter({
  owner,
  updatedAt,
  className,
  testId,
}: ResourceCardFooterProps) {
  const normalizedOwner = owner?.trim() || null
  const updatedDate = updatedAt ? new Date(updatedAt) : null
  const hasUpdatedDate = updatedDate !== null && !Number.isNaN(updatedDate.getTime())
  const updatedDateLabel = hasUpdatedDate ? format(updatedDate, 'yyyy-MM-dd') : null
  const updatedTitle = hasUpdatedDate ? format(updatedDate, 'yyyy-MM-dd HH:mm:ss') : undefined

  if (!normalizedOwner && !updatedDateLabel) return null

  return (
    <div
      className={cn(
        'mt-auto flex min-w-0 items-center justify-between gap-3 text-xs text-text-muted',
        className
      )}
      data-testid={testId}
    >
      {normalizedOwner && (
        <span className="min-w-0 truncate" title={normalizedOwner}>
          {normalizedOwner}
        </span>
      )}
      {updatedDateLabel && (
        <time className="ml-auto shrink-0" dateTime={updatedAt || undefined} title={updatedTitle}>
          {updatedDateLabel}
        </time>
      )}
    </div>
  )
}
