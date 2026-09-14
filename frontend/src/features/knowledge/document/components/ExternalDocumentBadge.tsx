// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { BookOpen } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

export function ExternalDocumentBadge({
  className,
  extension,
  syncedWiki = false,
}: {
  className?: string
  extension?: string | null
  syncedWiki?: boolean
}) {
  const { t } = useTranslation('knowledge')
  if (syncedWiki) {
    const format = extension?.trim().replace(/^\.+/, '').toUpperCase() || 'MD'
    const label = t('wikiSection.synced_badge')
    return (
      <span
        className={cn('inline-flex items-center gap-1 text-xs text-text-muted', className)}
        data-testid="synced-wiki-document-type"
        title={label}
      >
        <span>{format}</span>
        <BookOpen
          aria-label={label}
          className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400"
        />
      </span>
    )
  }
  return (
    <Badge
      variant="default"
      size="sm"
      className={cn('bg-amber-500/10 text-amber-600 border-amber-500/20', className)}
    >
      {t('document.document.type.external')}
    </Badge>
  )
}
