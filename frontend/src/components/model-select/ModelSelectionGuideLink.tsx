// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { ExternalLink } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { getRuntimeConfigSync } from '@/lib/runtime-config'
import { cn } from '@/lib/utils'

export function ModelSelectionGuideLink({ className }: { className?: string }) {
  const { t } = useTranslation('common')
  const url = getRuntimeConfigSync().modelSelectionGuideUrl
  if (!url) return null

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="model-selection-guide-link"
      className={cn(
        'inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-xs text-text-secondary hover:bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary md:min-h-0 md:py-1.5',
        className
      )}
    >
      {t('models.selection_guide')}
      <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
    </a>
  )
}
