// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Badge } from '@/components/ui/badge'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { KnowledgeDocument } from '@/types/knowledge'

export function ExternalDocumentBadge({
  document,
  className,
}: {
  document: Pick<KnowledgeDocument, 'attachment_id' | 'file_extension'>
  className?: string
}) {
  const { t } = useTranslation('knowledge')
  const extension = document.attachment_id
    ? document.file_extension?.trim().replace(/^\.+/, '').toUpperCase()
    : ''
  return (
    <span className="inline-flex max-w-full flex-wrap items-center justify-center gap-1 align-middle">
      {extension && <span className="text-xs text-text-muted">{extension}</span>}
      <Badge
        variant="default"
        size="sm"
        className={cn('bg-amber-500/10 text-amber-600 border-amber-500/20', className)}
      >
        {t('document.document.type.external')}
      </Badge>
    </span>
  )
}
