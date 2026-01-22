'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Market page inline component for browsing and renting market subscriptions.
 */
import { useState, useEffect, useCallback } from 'react'
import { Search, Store, TrendingUp, Clock, Users, Check } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTranslation } from '@/hooks/useTranslation'
import { subscriptionApis } from '@/apis/subscription'
import type { MarketSubscriptionDetail } from '@/types/subscription'
import { RentSubscriptionDialog } from './RentSubscriptionDialog'
import { useToast } from '@/hooks/use-toast'

interface MarketPageInlineProps {
  onRentalSuccess?: () => void
}

export function MarketPageInline({ onRentalSuccess }: MarketPageInlineProps) {
  const { t } = useTranslation('feed')
  const { toast } = useToast()
  const [subscriptions, setSubscriptions] = useState<MarketSubscriptionDetail[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<'rental_count' | 'recent'>('rental_count')
  const [selectedSubscription, setSelectedSubscription] = useState<MarketSubscriptionDetail | null>(
    null
  )
  const [rentDialogOpen, setRentDialogOpen] = useState(false)

  const loadSubscriptions = useCallback(async () => {
    try {
      setLoading(true)
      const response = await subscriptionApis.discoverMarketSubscriptions({
        page: 1,
        limit: 50,
        sortBy,
        search: search || undefined,
      })
      setSubscriptions(response.items)
    } catch (error) {
      console.error('Failed to load market subscriptions:', error)
      toast({
        title: t('common:error'),
        description: String(error),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [sortBy, search, toast, t])

  useEffect(() => {
    loadSubscriptions()
  }, [loadSubscriptions])

  const handleRent = useCallback((subscription: MarketSubscriptionDetail) => {
    setSelectedSubscription(subscription)
    setRentDialogOpen(true)
  }, [])

  const handleRentSuccess = useCallback(() => {
    setRentDialogOpen(false)
    setSelectedSubscription(null)
    loadSubscriptions()
    onRentalSuccess?.()
  }, [loadSubscriptions, onRentalSuccess])

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value)
  }, [])

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        loadSubscriptions()
      }
    },
    [loadSubscriptions]
  )

  return (
    <div className="h-full flex flex-col">
      {/* Header with search and sort */}
      <div className="p-4 space-y-3 border-b border-border bg-base">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t('discover_search_placeholder')}
              value={search}
              onChange={handleSearchChange}
              onKeyDown={handleSearchKeyDown}
              className="pl-9"
            />
          </div>
        </div>
        <div className="flex items-center justify-between">
          <ToggleGroup
            type="single"
            value={sortBy}
            onValueChange={value => value && setSortBy(value as 'rental_count' | 'recent')}
            className="gap-1"
          >
            <ToggleGroupItem value="rental_count" size="sm" className="gap-1.5 text-xs h-7 px-2">
              <TrendingUp className="h-3.5 w-3.5" />
              {t('market.sort_by_rental_count')}
            </ToggleGroupItem>
            <ToggleGroupItem value="recent" size="sm" className="gap-1.5 text-xs h-7 px-2">
              <Clock className="h-3.5 w-3.5" />
              {t('sort_by_recent')}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      {/* Subscription list */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-28 w-full rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        ) : subscriptions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-12">
            <Store className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium text-text-primary mb-2">
              {t('market.no_market_subscriptions')}
            </h3>
            <p className="text-sm text-text-muted max-w-sm">
              {t('market.no_market_subscriptions_hint')}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {subscriptions.map(subscription => (
              <MarketSubscriptionCard
                key={subscription.id}
                subscription={subscription}
                onRent={handleRent}
              />
            ))}
          </div>
        )}
      </div>

      {/* Rent dialog */}
      {selectedSubscription && (
        <RentSubscriptionDialog
          open={rentDialogOpen}
          onOpenChange={setRentDialogOpen}
          subscription={selectedSubscription}
          onSuccess={handleRentSuccess}
        />
      )}
    </div>
  )
}

interface MarketSubscriptionCardProps {
  subscription: MarketSubscriptionDetail
  onRent: (subscription: MarketSubscriptionDetail) => void
}

function MarketSubscriptionCard({ subscription, onRent }: MarketSubscriptionCardProps) {
  const { t } = useTranslation('feed')

  return (
    <Card className="hover:bg-surface/50 transition-colors">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="font-medium text-text-primary truncate">
                {subscription.display_name}
              </h3>
              <Badge variant="secondary" className="text-xs shrink-0">
                {subscription.task_type === 'execution'
                  ? t('task_type_execution')
                  : t('task_type_collection')}
              </Badge>
            </div>
            {subscription.description && (
              <p className="text-sm text-text-muted line-clamp-2 mb-2">
                {subscription.description}
              </p>
            )}
            <div className="flex items-center gap-4 text-xs text-text-muted">
              <span className="flex items-center gap-1">
                <Users className="h-3.5 w-3.5" />
                {subscription.owner_username}
              </span>
              <span className="flex items-center gap-1">
                <Store className="h-3.5 w-3.5" />
                {t('market.rental_count', { count: subscription.rental_count })}
              </span>
              <span className="text-text-muted">{subscription.trigger_description}</span>
            </div>
          </div>
          <div className="shrink-0">
            {subscription.is_rented ? (
              <Button variant="outline" size="sm" disabled className="gap-1.5">
                <Check className="h-4 w-4" />
                {t('market.rented')}
              </Button>
            ) : (
              <Button variant="default" size="sm" onClick={() => onRent(subscription)}>
                {t('market.rent')}
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
