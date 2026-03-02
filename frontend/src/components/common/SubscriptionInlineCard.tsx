// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo } from 'react'
import { Skeleton } from '@/components/ui/skeleton'

interface SubscriptionInlineCardProps {
  subscriptionId: number
  theme?: 'light' | 'dark'
}

export const SubscriptionInlineCard = memo(function SubscriptionInlineCard({
  subscriptionId,
  theme = 'light',
}: SubscriptionInlineCardProps) {
  return (
    <div
      className="my-2 rounded-lg border border-border bg-surface p-4"
      data-testid="subscription-inline-card"
      data-theme={theme}
      data-subscription-id={subscriptionId}
    >
      <Skeleton className="h-4 w-3/4" data-testid="subscription-card-skeleton" />
      <Skeleton className="mt-2 h-3 w-1/2" />
    </div>
  )
})

export default SubscriptionInlineCard
