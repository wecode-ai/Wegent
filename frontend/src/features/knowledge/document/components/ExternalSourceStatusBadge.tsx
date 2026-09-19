// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { KnowledgeDocument } from '@/types/knowledge'

import { getExternalSourceInfo, isExternalSourceUnavailable } from '../utils/documentUtils'

/**
 * Warning badge for an imported copy whose source can no longer be reached.
 * One mapping serves the list, the tree and the preview, so they never disagree;
 * the provider's own failure text stays in the logs, not in the tooltip.
 */
export function ExternalSourceStatusBadge({
  document,
  testId,
  className,
}: {
  document: Pick<KnowledgeDocument, 'source_type' | 'source_config'>
  /** Each surface keeps the test id it already published. */
  testId?: string
  className?: string
}) {
  const { t } = useTranslation('knowledge')
  if (!isExternalSourceUnavailable(document)) return null

  const syncFailed = getExternalSourceInfo(document)?.status === 'sync_error'
  return (
    <TooltipProvider>
      <Tooltip delayDuration={200}>
        <TooltipTrigger asChild>
          <Badge
            variant="default"
            size="sm"
            className={cn(
              'cursor-help whitespace-nowrap bg-red-500/10 text-red-600 border-red-500/20',
              className
            )}
            data-testid={testId}
          >
            {syncFailed
              ? t('document.document.sourceSyncFailed')
              : t('document.document.sourceInaccessible')}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <p className="text-xs">
            {syncFailed
              ? t('document.document.sourceSyncFailedHint')
              : t('document.document.sourceInaccessibleHint')}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
