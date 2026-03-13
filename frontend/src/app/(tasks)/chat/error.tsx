// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'

/**
 * Next.js error boundary for the chat route.
 * Catches rendering errors in ChatPageDesktop/ChatPageMobile and shows
 * a recovery UI instead of a blank white screen.
 */
export default function ChatError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const { t } = useTranslation('common')

  useEffect(() => {
    console.error('[ChatError] Caught rendering error:', error)
  }, [error])

  return (
    <div className="flex h-full w-full items-center justify-center bg-base">
      <div className="flex flex-col items-center gap-4 text-center">
        <p className="text-sm text-text-secondary">{t('errors.request_failed')}</p>
        <Button variant="primary" onClick={reset}>
          {t('actions.retry')}
        </Button>
      </div>
    </div>
  )
}
