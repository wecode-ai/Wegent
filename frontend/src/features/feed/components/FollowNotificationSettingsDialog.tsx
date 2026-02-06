'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Follow notification settings dialog component.
 * Allows users to configure notification level and channels for followed subscriptions.
 */
import { useCallback, useEffect, useState } from 'react'
import { Bell, BellOff, BellRing, Loader2, MessageSquare } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { subscriptionApis } from '@/apis/subscription'
import type { NotificationLevel, FollowSettingsResponse } from '@/types/subscription'

interface FollowNotificationSettingsDialogProps {
  subscriptionId: number
  subscriptionName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSettingsUpdated?: () => void
}

export function FollowNotificationSettingsDialog({
  subscriptionId,
  subscriptionName,
  open,
  onOpenChange,
  onSettingsUpdated,
}: FollowNotificationSettingsDialogProps) {
  const { t } = useTranslation('feed')

  // State
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [settings, setSettings] = useState<FollowSettingsResponse | null>(null)
  const [selectedLevel, setSelectedLevel] = useState<NotificationLevel>('default')
  const [selectedChannels, setSelectedChannels] = useState<number[]>([])

  // Load settings when dialog opens
  const loadSettings = useCallback(async () => {
    try {
      setLoading(true)
      const response = await subscriptionApis.getFollowSettings(subscriptionId)
      setSettings(response)
      setSelectedLevel(response.notification_level)
      setSelectedChannels(response.notification_channel_ids)
    } catch (error) {
      console.error('Failed to load follow settings:', error)
      toast.error(t('common:errors.load_failed'))
    } finally {
      setLoading(false)
    }
  }, [subscriptionId, t])

  useEffect(() => {
    if (open && subscriptionId) {
      loadSettings()
    }
  }, [open, subscriptionId, loadSettings])

  // Handle save
  const handleSave = useCallback(async () => {
    try {
      setSaving(true)
      await subscriptionApis.updateFollowSettings(subscriptionId, {
        notification_level: selectedLevel,
        notification_channel_ids: selectedLevel === 'notify' ? selectedChannels : undefined,
      })
      toast.success(t('notification_settings.save_success'))
      onOpenChange(false)
      onSettingsUpdated?.()
    } catch (error) {
      console.error('Failed to save follow settings:', error)
      toast.error(t('notification_settings.save_failed'))
    } finally {
      setSaving(false)
    }
  }, [subscriptionId, selectedLevel, selectedChannels, t, onOpenChange, onSettingsUpdated])

  // Handle channel toggle
  const handleChannelToggle = useCallback((channelId: number, checked: boolean) => {
    setSelectedChannels(prev =>
      checked ? [...prev, channelId] : prev.filter(id => id !== channelId)
    )
  }, [])

  // Get channel type icon
  const getChannelIcon = (_channelType: string) => {
    // For now, use a generic message icon
    // Can be extended to show specific icons for dingtalk, feishu, etc.
    return <MessageSquare className="h-4 w-4" />
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{t('notification_settings.title')}</DialogTitle>
          <DialogDescription>
            {t('notification_settings.description', { name: subscriptionName })}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : (
          <div className="space-y-6 py-4">
            {/* Notification Level Selection */}
            <div className="space-y-3">
              <Label className="text-sm font-medium">
                {t('notification_settings.level_label')}
              </Label>
              <RadioGroup
                value={selectedLevel}
                onValueChange={value => setSelectedLevel(value as NotificationLevel)}
                className="space-y-2"
              >
                <div className="flex items-center space-x-3 rounded-lg border p-3 hover:bg-surface/50">
                  <RadioGroupItem value="silent" id="level-silent" />
                  <Label
                    htmlFor="level-silent"
                    className="flex flex-1 cursor-pointer items-center gap-2"
                  >
                    <BellOff className="h-4 w-4 text-text-muted" />
                    <div>
                      <div className="font-medium">{t('notification_settings.level_silent')}</div>
                      <div className="text-xs text-text-muted">
                        {t('notification_settings.level_silent_desc')}
                      </div>
                    </div>
                  </Label>
                </div>

                <div className="flex items-center space-x-3 rounded-lg border p-3 hover:bg-surface/50">
                  <RadioGroupItem value="default" id="level-default" />
                  <Label
                    htmlFor="level-default"
                    className="flex flex-1 cursor-pointer items-center gap-2"
                  >
                    <Bell className="h-4 w-4 text-text-muted" />
                    <div>
                      <div className="font-medium">{t('notification_settings.level_default')}</div>
                      <div className="text-xs text-text-muted">
                        {t('notification_settings.level_default_desc')}
                      </div>
                    </div>
                  </Label>
                </div>

                <div className="flex items-center space-x-3 rounded-lg border p-3 hover:bg-surface/50">
                  <RadioGroupItem value="notify" id="level-notify" />
                  <Label
                    htmlFor="level-notify"
                    className="flex flex-1 cursor-pointer items-center gap-2"
                  >
                    <BellRing className="h-4 w-4 text-text-muted" />
                    <div>
                      <div className="font-medium">{t('notification_settings.level_notify')}</div>
                      <div className="text-xs text-text-muted">
                        {t('notification_settings.level_notify_desc')}
                      </div>
                    </div>
                  </Label>
                </div>
              </RadioGroup>
            </div>

            {/* Channel Selection (only shown when notify level is selected) */}
            {selectedLevel === 'notify' && settings?.available_channels && (
              <div className="space-y-3">
                <Label className="text-sm font-medium">
                  {t('notification_settings.channels_label')}
                </Label>
                {settings.available_channels.length === 0 ? (
                  <div className="rounded-lg border border-dashed p-4 text-center text-sm text-text-muted">
                    {t('notification_settings.no_channels')}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {settings.available_channels.map(channel => (
                      <div
                        key={channel.id}
                        className={`flex items-center space-x-3 rounded-lg border p-3 ${
                          !channel.is_bound ? 'opacity-50' : 'hover:bg-surface/50'
                        }`}
                      >
                        <Checkbox
                          id={`channel-${channel.id}`}
                          checked={selectedChannels.includes(channel.id)}
                          onCheckedChange={checked =>
                            handleChannelToggle(channel.id, checked as boolean)
                          }
                          disabled={!channel.is_bound}
                        />
                        <Label
                          htmlFor={`channel-${channel.id}`}
                          className="flex flex-1 cursor-pointer items-center gap-2"
                        >
                          {getChannelIcon(channel.channel_type)}
                          <div>
                            <div className="font-medium">{channel.name}</div>
                            <div className="text-xs text-text-muted">
                              {channel.channel_type}
                              {!channel.is_bound && (
                                <span className="ml-2 text-warning">
                                  ({t('notification_settings.not_bound')})
                                </span>
                              )}
                            </div>
                          </div>
                        </Label>
                      </div>
                    ))}
                  </div>
                )}
                {settings.available_channels.some(c => !c.is_bound) && (
                  <p className="text-xs text-text-muted">{t('notification_settings.bind_hint')}</p>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={loading || saving}>
            {saving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('common:actions.saving')}
              </>
            ) : (
              t('common:actions.save')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
