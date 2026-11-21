// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { ReadFailure } from './evidenceRead'

export function EvidenceReadError({
  failure,
  onRetry,
}: {
  failure: ReadFailure
  onRetry: () => void
}) {
  const { t } = useTranslation('chat')
  return (
    <div role="alert">
      <p>{t(`evidence.${failure.key}`)}</p>
      {failure.retryable && (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 min-w-11"
          data-testid={`answer-evidence-retry-${failure.key}`}
          onClick={onRetry}
        >
          {t('evidence.retry')}
        </Button>
      )}
    </div>
  )
}
