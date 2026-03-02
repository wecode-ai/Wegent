// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo, useEffect, useState, useCallback } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { subscriptionApis } from '@/apis/subscription'
import type { Subscription } from '@/types/subscription'

interface SubscriptionInlineCardProps {
  subscriptionId: number
  theme?: 'light' | 'dark'
}

type CardState =
  | { status: 'loading' }
  | { status: 'error'; error: Error }
  | { status: 'loaded'; subscription: Subscription }

export const SubscriptionInlineCard = memo(function SubscriptionInlineCard({
  subscriptionId,
  theme = 'light',
}: SubscriptionInlineCardProps) {
  const [state, setState] = useState<CardState>({ status: 'loading' })

  const fetchSubscription = useCallback(async () => {
    setState({ status: 'loading' })
    try {
      const subscription = await subscriptionApis.getSubscription(subscriptionId)
      setState({ status: 'loaded', subscription })
    } catch (error) {
      setState({
        status: 'error',
        error: error instanceof Error ? error : new Error('Failed to load subscription'),
      })
    }
  }, [subscriptionId])

  useEffect(() => {
    fetchSubscription()
  }, [fetchSubscription])

  if (state.status === 'loading') {
    return (
      <div
        className="my-2 rounded-lg border border-border bg-surface p-4"
        data-testid="subscription-inline-card"
        data-theme={theme}
      >
        <Skeleton className="h-4 w-3/4" data-testid="subscription-card-skeleton" />
        <Skeleton className="mt-2 h-3 w-1/2" />
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div
        className="my-2 rounded-lg border border-border bg-surface p-4"
        data-testid="subscription-inline-card"
      >
        <div className="flex items-center gap-2 text-yellow-600">
          <AlertCircle className="h-4 w-4" />
          <span className="text-sm">Failed to load subscription</span>
        </div>
        <Button variant="outline" size="sm" className="mt-2" onClick={fetchSubscription}>
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div
      className="my-2 rounded-lg border border-border bg-surface p-4"
      data-testid="subscription-inline-card"
    >
      <div className="font-medium">{state.subscription.display_name}</div>
      <div className="text-sm text-text-secondary">{state.subscription.trigger_type}</div>
    </div>
  )
})

export default SubscriptionInlineCard
