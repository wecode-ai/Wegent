// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useTranslation } from '@/hooks/useTranslation'

export function KnowledgeUrlStatus({
  status,
  onRetry,
  compact = false,
}: {
  status: 'loading' | 'not-found' | 'ambiguous' | 'error'
  onRetry: () => void
  compact?: boolean
}) {
  const { t } = useTranslation('knowledge')
  return (
    <div
      className={`${compact ? 'shrink-0' : 'flex-1 h-full'} flex flex-col items-center justify-center gap-3 p-4 text-text-secondary`}
      data-testid={`knowledge-url-${status}`}
      role={status === 'loading' ? 'status' : 'alert'}
    >
      {status === 'loading' ? <Spinner size="lg" /> : <p>{t(`urlResolution.${status}`)}</p>}
      {status === 'error' && (
        <Button className="min-h-11" onClick={onRetry} data-testid="knowledge-url-retry">
          {t('urlResolution.retry')}
        </Button>
      )}
    </div>
  )
}
