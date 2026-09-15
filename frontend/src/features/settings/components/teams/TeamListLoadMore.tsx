// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

interface Props {
  hasMore: boolean
  loading: boolean
  failed: boolean
  onLoadMore: () => Promise<void>
  onRetry: () => Promise<void>
}

export function TeamListLoadMore({ hasMore, loading, failed, onLoadMore, onRetry }: Props) {
  const { t } = useTranslation('resource-library')
  const trigger = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = trigger.current
    if (!element || !hasMore || loading || failed) return
    const observer = new IntersectionObserver(
      entries => {
        if (!entries.some(entry => entry.isIntersecting)) return
        observer.unobserve(element)
        void onLoadMore()
      },
      { rootMargin: '100px 0px' }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [hasMore, loading, failed, onLoadMore])

  if (!hasMore && !failed) return null
  return (
    <div
      ref={trigger}
      className="col-span-full flex min-h-10 items-center justify-center"
      data-testid="team-list-load-more-trigger"
    >
      {failed ? (
        <Button variant="outline" onClick={() => void onRetry()} data-testid="team-list-retry">
          {t('actions.retry')}
        </Button>
      ) : loading ? (
        <Loader2 className="h-5 w-5 animate-spin" aria-label={t('states.loading')} />
      ) : null}
    </div>
  )
}
