// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { KnowledgeDocument } from '@/types/knowledge'

import {
  getExternalSourceInfo,
  isExternalSourceUnavailable,
  isSyncedWikiDocument,
  isWikiSourceMissing,
} from '../utils/documentUtils'

type Translate = (key: string) => string

/**
 * The one mapping of an unreachable source, shared by the list, the tree, the
 * compact rows and the preview so they never disagree.
 *
 * The provider's own failure text is user-facing only for a synchronized Wiki
 * copy, where the backend already vets it; every other copy keeps the shared
 * wording and leaves the provider text in the logs.
 */
function getExternalSourceStatusText(
  document: Pick<KnowledgeDocument, 'source_type' | 'source_config'>,
  t: Translate
): { label: string; hint: string } | null {
  if (!isExternalSourceUnavailable(document)) return null

  const source = getExternalSourceInfo(document)
  const syncFailed = source?.status === 'sync_error'
  const wikiSourceMissing = isWikiSourceMissing(document)
  const label = wikiSourceMissing
    ? t('document.document.wikiSourceMissing')
    : syncFailed
      ? t('document.document.sourceSyncFailed')
      : t('document.document.sourceInaccessible')
  const sharedHint = wikiSourceMissing
    ? t('document.document.wikiSourceMissingHint')
    : syncFailed
      ? t('document.document.sourceSyncFailedHint')
      : t('document.document.sourceInaccessibleHint')
  return {
    label,
    hint: (isSyncedWikiDocument(document) && source?.last_error) || sharedHint,
  }
}

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
  const status = getExternalSourceStatusText(document, t)
  if (!status) return null
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
            {status.label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <p className="text-xs">{status.hint}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
