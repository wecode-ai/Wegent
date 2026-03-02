// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo, useEffect, useState, useCallback } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { AlertCircle, Pencil, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { subscriptionApis } from '@/apis/subscription'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  Subscription,
  SubscriptionUpdateRequest,
  SubscriptionTriggerType,
} from '@/types/subscription'

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
  const [isEditing, setIsEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draftConfig, setDraftConfig] = useState<Partial<SubscriptionUpdateRequest>>({})

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

  const handleEdit = useCallback(() => {
    if (state.status !== 'loaded') return
    setDraftConfig({
      trigger_type: state.subscription.trigger_type,
      trigger_config: { ...state.subscription.trigger_config },
    })
    setIsEditing(true)
  }, [state])

  const handleCancel = useCallback(() => {
    setIsEditing(false)
    setDraftConfig({})
  }, [])

  const handleSave = useCallback(async () => {
    if (state.status !== 'loaded') return

    setSaving(true)
    try {
      const subscription = await subscriptionApis.updateSubscription(subscriptionId, draftConfig)
      setState({ status: 'loaded', subscription })
      setIsEditing(false)
      setDraftConfig({})
    } catch (error) {
      console.error('Failed to save subscription:', error)
    } finally {
      setSaving(false)
    }
  }, [state, subscriptionId, draftConfig])

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

  if (isEditing) {
    return (
      <div
        className="my-2 rounded-lg border border-border bg-surface p-4"
        data-testid="subscription-inline-card"
      >
        <div className="mb-4 font-medium">{state.subscription.display_name}</div>

        <TriggerEditor
          triggerType={draftConfig.trigger_type || state.subscription.trigger_type}
          triggerConfig={draftConfig.trigger_config || state.subscription.trigger_config}
          onChange={(type, config) =>
            setDraftConfig({
              trigger_type: type as SubscriptionTriggerType,
              trigger_config: config,
            })
          }
        />

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={handleCancel} disabled={saving}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
            {saving ? t('common:actions.saving') : t('common:actions.save')}
          </Button>
        </div>
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
      <div className="mt-3 flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={handleEdit}>
          <Pencil className="mr-1 h-3 w-3" />
          {t('edit')}
        </Button>
        <Button variant="ghost" size="sm" asChild>
          <a
            href={`/feed/subscriptions?edit=${subscriptionId}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink className="mr-1 h-3 w-3" />
            {t('feed.view_details')}
          </a>
        </Button>
      </div>
    </div>
  )
})

interface TriggerEditorProps {
  triggerType: SubscriptionTriggerType
  triggerConfig: Record<string, unknown>
  onChange: (type: SubscriptionTriggerType, config: Record<string, unknown>) => void
}

function TriggerEditor({ triggerType, triggerConfig, onChange }: TriggerEditorProps) {
  const { t } = useTranslation('feed')

  if (triggerType === 'cron') {
    return (
      <div className="space-y-3">
        <div>
          <label className="text-sm font-medium">{t('cron_expression')}</label>
          <Input
            value={(triggerConfig?.expression as string) || ''}
            onChange={e => onChange('cron', { ...triggerConfig, expression: e.target.value })}
            placeholder="0 9 * * *"
          />
        </div>
        <div>
          <label className="text-sm font-medium">{t('timezone_hint')}</label>
          <Input
            value={(triggerConfig?.timezone as string) || 'Asia/Shanghai'}
            onChange={e => onChange('cron', { ...triggerConfig, timezone: e.target.value })}
          />
        </div>
      </div>
    )
  }

  if (triggerType === 'interval') {
    return (
      <div className="space-y-3">
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="text-sm font-medium">{t('interval_value')}</label>
            <Input
              type="number"
              value={(triggerConfig?.value as number) || 1}
              onChange={e =>
                onChange('interval', {
                  ...triggerConfig,
                  value: parseInt(e.target.value),
                })
              }
              min={1}
            />
          </div>
          <div className="flex-1">
            <label className="text-sm font-medium">{t('interval_unit')}</label>
            <Select
              value={(triggerConfig?.unit as string) || 'hours'}
              onValueChange={value => onChange('interval', { ...triggerConfig, unit: value })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="minutes">{t('unit_minutes')}</SelectItem>
                <SelectItem value="hours">{t('unit_hours')}</SelectItem>
                <SelectItem value="days">{t('unit_days')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    )
  }

  if (triggerType === 'one_time') {
    return (
      <div>
        <label className="text-sm font-medium">{t('execute_at')}</label>
        <Input
          type="datetime-local"
          value={(triggerConfig?.execute_at as string)?.slice(0, 16) || ''}
          onChange={e => onChange('one_time', { ...triggerConfig, execute_at: e.target.value })}
        />
      </div>
    )
  }

  return null
}

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
