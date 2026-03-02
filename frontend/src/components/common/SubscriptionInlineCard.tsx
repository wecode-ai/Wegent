// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo, useEffect, useState, useCallback } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { subscriptionApis } from '@/apis/subscription'
import { useTranslation } from '@/hooks/useTranslation'
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
  const { t } = useTranslation('feed')
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

  const handleToggleEnabled = useCallback(async () => {
    if (state.status !== 'loaded') return

    const newEnabled = !state.subscription.enabled
    try {
      const subscription = await subscriptionApis.updateSubscription(subscriptionId, {
        enabled: newEnabled,
      })
      setState({ status: 'loaded', subscription })
    } catch (error) {
      console.error('Failed to update subscription:', error)
    }
  }, [state, subscriptionId])

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
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium">{state.subscription.display_name}</div>
          <div className="text-sm text-text-secondary">
            {formatTriggerSummary(state.subscription)}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-text-secondary">
            {state.subscription.enabled ? t('enabled_success') : t('disabled_success')}
          </span>
          <Switch
            checked={state.subscription.enabled}
            onCheckedChange={handleToggleEnabled}
            aria-label={t('enable_subscription')}
          />
        </div>
      </div>
    </div>
  )
})

function formatTriggerSummary(subscription: Subscription): string {
  const { trigger_type, trigger_config } = subscription

  if (trigger_type === 'cron') {
    const expr = (trigger_config?.expression as string) || ''
    return `Cron: ${expr}`
  }

  if (trigger_type === 'interval') {
    const value = trigger_config?.value
    const unit = trigger_config?.unit
    return `Every ${value} ${unit}`
  }

  if (trigger_type === 'one_time') {
    const executeAt = trigger_config?.execute_at as string
    return `Once at ${executeAt}`
  }

  return trigger_type
}

export default SubscriptionInlineCard
