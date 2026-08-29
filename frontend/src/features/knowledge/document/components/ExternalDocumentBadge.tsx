// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Badge } from '@/components/ui/badge'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

export function ExternalDocumentBadge({ className }: { className?: string }) {
  const { t } = useTranslation('knowledge')
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
