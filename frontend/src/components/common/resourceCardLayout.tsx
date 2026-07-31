// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

interface ResourceCardLayoutOptions {
  reserveActionsHeight?: boolean
}

export function getResourceGridClassName(compact: boolean): string {
  return compact
    ? 'grid grid-cols-1 content-start gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
    : 'space-y-3'
}

export function getResourceCardClassName(
  compact: boolean,
  { reserveActionsHeight = false }: ResourceCardLayoutOptions = {}
): string {
  return cn(
    'overflow-hidden border-border bg-surface transition duration-200',
    compact
      ? 'flex flex-col rounded-xl p-4 shadow-sm hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-md'
      : 'p-3 hover:bg-hover sm:p-4',
    compact && reserveActionsHeight && 'min-h-[196px]'
  )
}

export function getResourceCardBodyClassName(compact: boolean): string {
  return cn(
    'flex min-w-0 gap-3',
    compact ? 'flex-1 flex-col' : 'flex-col sm:flex-row sm:items-center sm:justify-between'
  )
}

export function getResourceCardActionsClassName(compact: boolean): string {
  return compact ? 'mt-auto w-full border-t border-border/70 pt-3' : 'self-end sm:ml-3 sm:self-auto'
}

export function ResourceCardIcon({ compact, children }: { compact: boolean; children: ReactNode }) {
  if (!compact) return children

  return (
    <span
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-primary/10 bg-primary/5 text-primary"
      data-testid="resource-card-icon"
    >
      {children}
    </span>
  )
}
