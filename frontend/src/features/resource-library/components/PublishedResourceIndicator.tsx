// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Store } from 'lucide-react'

import { useTranslation } from '@/hooks/useTranslation'

interface PublishedResourceIndicatorProps {
  testId?: string
}

export function PublishedResourceIndicator({ testId }: PublishedResourceIndicatorProps) {
  const { t } = useTranslation('resource-library')
  const label = t('publication.published_to_library')

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary"
      data-testid={testId}
    >
      <Store className="h-4 w-4" aria-hidden />
    </span>
  )
}
