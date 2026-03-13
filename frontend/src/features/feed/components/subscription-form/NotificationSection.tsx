'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Notification Section - Notification level, channels, and webhooks
 */

import { Bell, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { CollapsibleSection } from '@/components/common/CollapsibleSection'
import type { NotificationLevel, NotificationWebhookType } from '@/types/subscription'
import type { NotificationSectionProps } from './types'

export function NotificationSection({
  devNotificationLevel,
  setDevNotificationLevel,
  devNotificationChannels,
  setDevNotificationChannels,
  devAvailableChannels,
  devSettingsLoading,
  notificationWebhooks,
  setNotificationWebhooks,
}: NotificationSectionProps) {
  const { t } = useTranslation('feed')

  return (
    <CollapsibleSection
      title={t('notification_settings.title')}
      icon={<Bell className="h-4 w-4 text-primary" />}
      defaultOpen={true}
    >
      {/* Notification Level Selection */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">{t('notification_settings.level_label')}</Label>
        <div className="flex gap-2">
          {(['silent', 'default', 'notify'] as NotificationLevel[]).map(level => (
            <Button
              key={level}
              type="button"
              variant={devNotificationLevel === level ? 'primary' : 'outline'}
              size="sm"
              className="flex-1 h-9"
              onClick={() => setDevNotificationLevel(level)}
              disabled={devSettingsLoading}
            >
              {t(`notification_level.${level}`)}
            </Button>
          ))}
        </div>

        {/* Notification Channels - Only show when level is 'notify' */}
        {devNotificationLevel === 'notify' && (
          <div className="space-y-2 mt-3">
            <Label className="text-xs text-text-muted">
              {t('notification_settings.channels_label')}
            </Label>
            {devAvailableChannels.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {devAvailableChannels.map(channel => (
                  <Button
                    key={channel.id}
                    type="button"
                    variant={devNotificationChannels.includes(channel.id) ? 'primary' : 'outline'}
                    size="sm"
                    className="h-8"
                    onClick={() => {
                      setDevNotificationChannels(prev =>
                        prev.includes(channel.id)
                          ? prev.filter(id => id !== channel.id)
                          : [...prev, channel.id]
                      )
                    }}
                    disabled={devSettingsLoading}
                  >
                    {channel.name}
                    {!channel.is_bound && (
                      <span className="ml-1 text-xs opacity-60">
                        ({t('common:actions.configure')})
                      </span>
                    )}
                  </Button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-text-muted">{t('notification_settings.no_channels')}</p>
            )}
          </div>
        )}

        {devSettingsLoading && <p className="text-xs text-text-muted">{t('common:loading')}</p>}
      </div>

      {/* Webhook Notifications */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">{t('notification_settings.webhook_title')}</Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2"
            onClick={() => {
              setNotificationWebhooks(prev => [
                ...prev,
                { type: 'dingtalk' as NotificationWebhookType, url: '', enabled: true },
              ])
            }}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            {t('notification_settings.add_webhook')}
          </Button>
        </div>

        {notificationWebhooks.length === 0 ? (
          <p className="text-xs text-text-muted">{t('notification_settings.no_webhooks')}</p>
        ) : (
          <div className="space-y-3">
            {notificationWebhooks.map((webhook, index) => (
              <div
                key={index}
                className="space-y-2 p-3 rounded-md border border-border bg-background"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Select
                      value={webhook.type}
                      onValueChange={(value: NotificationWebhookType) => {
                        setNotificationWebhooks(prev =>
                          prev.map((w, i) => (i === index ? { ...w, type: value } : w))
                        )
                      }}
                    >
                      <SelectTrigger className="h-8 w-[120px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="dingtalk">
                          {t('notification_settings.webhook_type_dingtalk')}
                        </SelectItem>
                        <SelectItem value="feishu">
                          {t('notification_settings.webhook_type_feishu')}
                        </SelectItem>
                        <SelectItem value="custom">
                          {t('notification_settings.webhook_type_custom')}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <Switch
                      checked={webhook.enabled}
                      onCheckedChange={checked => {
                        setNotificationWebhooks(prev =>
                          prev.map((w, i) => (i === index ? { ...w, enabled: checked } : w))
                        )
                      }}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    onClick={() => {
                      setNotificationWebhooks(prev => prev.filter((_, i) => i !== index))
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <Input
                  value={webhook.url}
                  onChange={e => {
                    setNotificationWebhooks(prev =>
                      prev.map((w, i) => (i === index ? { ...w, url: e.target.value } : w))
                    )
                  }}
                  placeholder={t('notification_settings.webhook_url_placeholder')}
                  className="h-8 text-xs"
                />
                <Input
                  value={webhook.secret || ''}
                  onChange={e => {
                    setNotificationWebhooks(prev =>
                      prev.map((w, i) =>
                        i === index ? { ...w, secret: e.target.value || undefined } : w
                      )
                    )
                  }}
                  placeholder={t('notification_settings.webhook_secret_placeholder')}
                  className="h-8 text-xs"
                />
              </div>
            ))}
          </div>
        )}
        <p className="text-xs text-text-muted">{t('notification_settings.webhook_hint')}</p>
      </div>
    </CollapsibleSection>
  )
}
