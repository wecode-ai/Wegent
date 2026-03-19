'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Notification Section - Notification level, channels, and webhooks
 */

import { Bell, CheckCircle, Loader2, MessageCircle, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState, useEffect, useCallback } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { fetchRuntimeConfig, DEFAULT_BIND_GROUP_STEPS } from '@/lib/runtime-config'
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
import type {
  NotificationChannelBindingConfig,
  NotificationLevel,
  NotificationWebhookType,
} from '@/types/subscription'
import type { NotificationSectionProps } from './types'

// Group binding status card component
interface GroupBindingCardProps {
  channelId: number
  channelName: string
  config: {
    channel_id: number
    bind_private: boolean
    bind_group: boolean
    group_conversation_id?: string
    group_name?: string
  }
  isWaiting: boolean
  onStartBinding: () => void
  onCancelBinding: () => void
  onRebind: () => void
  onUnbind: () => void
}

function GroupBindingCard({
  channelName,
  config,
  isWaiting,
  onStartBinding,
  onCancelBinding,
  onRebind,
  onUnbind,
}: GroupBindingCardProps) {
  const { t } = useTranslation('feed')
  const isBound = Boolean(config.group_conversation_id)

  // Waiting state - show waiting card
  if (isWaiting) {
    return (
      <div className="rounded-md border border-border bg-surface/50 p-3">
        <div className="flex items-start gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-primary mt-0.5" />
          <div className="flex-1 space-y-2">
            <p className="text-sm font-medium">
              {t('notification_settings.group_binding_waiting_title', '正在等待群聊消息...')}
            </p>
            <p className="text-xs text-text-muted">
              {t(
                'notification_settings.group_binding_waiting_desc',
                '请在群聊中 @机器人 发送任意消息'
              )}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              onClick={onCancelBinding}
            >
              {t('common:actions.cancel')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // Bound state - show group info card with rebind/unbind buttons
  if (isBound) {
    return (
      <div className="rounded-md border border-border bg-surface/50 p-3">
        <div className="flex items-start gap-3">
          <CheckCircle className="h-5 w-5 text-success mt-0.5" />
          <div className="flex-1 space-y-2">
            <p className="text-sm font-medium">
              {t('notification_settings.group_bound_title', '已绑定群聊')}
            </p>
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm">
                <MessageCircle className="h-4 w-4 text-text-muted" />
                <span className="font-medium">{config.group_name || channelName}</span>
              </div>
              {config.group_conversation_id && (
                <p className="text-xs text-text-muted pl-6">
                  ID: {config.group_conversation_id.slice(0, 20)}
                  {config.group_conversation_id.length > 20 ? '...' : ''}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 pt-1">
              <Button type="button" variant="outline" size="sm" className="h-8" onClick={onRebind}>
                {t('notification_settings.rebind', '重新绑定')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-destructive hover:text-destructive"
                onClick={onUnbind}
              >
                {t('notification_settings.unbind', '解除绑定')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Unbound state - show bind button
  return (
    <div className="rounded-md border border-border bg-surface/50 p-3">
      <div className="flex items-start gap-3">
        <Bell className="h-5 w-5 text-text-muted mt-0.5" />
        <div className="flex-1 space-y-2">
          <p className="text-sm font-medium">
            {t('notification_settings.group_unbound_title', '尚未绑定群聊')}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            onClick={onStartBinding}
          >
            {t('notification_settings.bind_group_button', '点击绑定群聊')}
          </Button>
        </div>
      </div>
    </div>
  )
}

interface BindGroupStep {
  title: string
  hint?: string
}

interface BindGroupConfig {
  variables?: Record<string, string>
  steps: BindGroupStep[]
}

const defaultBindConfig: BindGroupConfig = JSON.parse(DEFAULT_BIND_GROUP_STEPS)

// Replace template variables like {{botName}} with actual values
const replaceVariables = (text: string, variables: Record<string, string>): string => {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] || `{{${key}}}`)
}

export function NotificationSection({
  devNotificationLevel,
  setDevNotificationLevel,
  devNotificationChannels,
  setDevNotificationChannels,
  devAvailableChannels,
  devSettingsLoading,
  notificationWebhooks,
  setNotificationWebhooks,
  channelBindingConfigs,
  setChannelBindingConfigs,
  onStartBinding,
  onCancelBinding,
  bindingWaitingState,
}: NotificationSectionProps) {
  const { t } = useTranslation('feed')
  const [privateBindingDialogChannel, setPrivateBindingDialogChannel] = useState<number | null>(
    null
  )
  const [groupBindingDialogChannel, setGroupBindingDialogChannel] = useState<number | null>(null)
  const [groupBindingState, setGroupBindingState] = useState<'idle' | 'waiting' | 'success'>('idle')
  const [boundGroupName, setBoundGroupName] = useState<string>('')
  const [bindConfig, setBindConfig] = useState<BindGroupConfig>(defaultBindConfig)

  // Fetch runtime config for binding steps
  useEffect(() => {
    // First try to read from NEXT_PUBLIC_* env var directly (build-time)
    const publicConfig = process.env.NEXT_PUBLIC_BIND_GROUP_STEPS
    if (publicConfig) {
      try {
        const parsed = JSON.parse(publicConfig) as BindGroupConfig
        if (parsed.steps && parsed.steps.length >= 3) {
          setBindConfig({
            variables: { ...defaultBindConfig.variables, ...parsed.variables },
            steps: parsed.steps,
          })
          return
        }
      } catch {
        // Fall through to API fetch
      }
    }

    // Otherwise fetch from runtime API
    fetchRuntimeConfig()
      .then(config => {
        if (config.bindGroupSteps) {
          try {
            const parsed = JSON.parse(config.bindGroupSteps) as BindGroupConfig
            if (parsed.steps && parsed.steps.length >= 3) {
              setBindConfig({
                variables: { ...defaultBindConfig.variables, ...parsed.variables },
                steps: parsed.steps,
              })
            }
          } catch {
            // Silently fail, use default config
          }
        }
      })
      .catch(() => {
        // Silently fail, use default config
      })
  }, [])

  const selectedDingtalkChannels = useMemo(() => {
    return devAvailableChannels.filter(
      channel => channel.channel_type === 'dingtalk' && devNotificationChannels.includes(channel.id)
    )
  }, [devAvailableChannels, devNotificationChannels])

  const getBindingConfig = useCallback(
    (channelId: number) =>
      channelBindingConfigs.find(
        (cfg: NotificationChannelBindingConfig) => cfg.channel_id === channelId
      ) ?? {
        channel_id: channelId,
        bind_private: true,
        bind_group: false,
      },
    [channelBindingConfigs]
  )

  // Monitor binding success when dialog is open
  useEffect(() => {
    if (groupBindingDialogChannel && groupBindingState === 'waiting') {
      const config = getBindingConfig(groupBindingDialogChannel)
      if (config.group_conversation_id) {
        setBoundGroupName(config.group_name || '')
        setGroupBindingState('success')
        // Auto close after 1.5 seconds
        setTimeout(() => {
          setGroupBindingDialogChannel(null)
          setGroupBindingState('idle')
        }, 1500)
      }
    }
  }, [groupBindingDialogChannel, groupBindingState, channelBindingConfigs, getBindingConfig])

  const updateBindingConfig = (
    channelId: number,
    updater: (prev: { bind_private: boolean; bind_group: boolean }) => {
      bind_private: boolean
      bind_group: boolean
    }
  ) => {
    setChannelBindingConfigs((prev: NotificationChannelBindingConfig[]) => {
      const existing = prev.find(
        (cfg: NotificationChannelBindingConfig) => cfg.channel_id === channelId
      ) ?? {
        channel_id: channelId,
        bind_private: true,
        bind_group: false,
      }
      const next = updater({
        bind_private: existing.bind_private,
        bind_group: existing.bind_group,
      })
      const rest = prev.filter(
        (cfg: NotificationChannelBindingConfig) => cfg.channel_id !== channelId
      )
      return [...rest, { ...existing, ...next }]
    })
  }

  // Clear group binding info from config
  const clearGroupBinding = (channelId: number) => {
    setChannelBindingConfigs((prev: NotificationChannelBindingConfig[]) => {
      const existing = prev.find(
        (cfg: NotificationChannelBindingConfig) => cfg.channel_id === channelId
      )
      if (!existing) return prev

      const rest = prev.filter(
        (cfg: NotificationChannelBindingConfig) => cfg.channel_id !== channelId
      )
      return [
        ...rest,
        {
          ...existing,
          group_conversation_id: undefined,
          group_name: undefined,
        },
      ]
    })
  }

  const getPrivateBound = (channelId: number) => {
    const channel = devAvailableChannels.find(item => item.id === channelId)
    return Boolean(channel?.is_bound)
  }

  // Handle starting group binding
  const handleStartGroupBinding = async (channelId: number) => {
    const config = getBindingConfig(channelId)
    await onStartBinding(channelId, config.bind_private, config.bind_group)
  }

  // Handle re-binding - clear current binding and start new one
  const handleRebind = async (channelId: number) => {
    clearGroupBinding(channelId)
    await handleStartGroupBinding(channelId)
  }

  // Handle unbinding - clear group info and uncheck bind_group
  const handleUnbind = async (channelId: number) => {
    clearGroupBinding(channelId)
    updateBindingConfig(channelId, prev => ({
      ...prev,
      bind_group: false,
    }))
    await onCancelBinding(channelId)
  }

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

            {selectedDingtalkChannels.length > 0 && (
              <div className="mt-3 space-y-3 rounded-md border border-border bg-surface/50 p-3">
                <Label className="text-xs text-text-muted">
                  {t('notification_settings.binding_hidden_options')}
                </Label>
                {selectedDingtalkChannels.map(channel => {
                  const config = getBindingConfig(channel.id)
                  const privateBound = getPrivateBound(channel.id)
                  const isWaiting = bindingWaitingState[channel.id] ?? false

                  return (
                    <div key={channel.id} className="space-y-3 rounded-md border border-border p-3">
                      <p className="text-xs font-medium text-text-muted">{channel.name}</p>

                      {/* Private chat binding */}
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={`bind-private-${channel.id}`}
                          checked={config.bind_private}
                          onCheckedChange={checked => {
                            const nextChecked = Boolean(checked)
                            updateBindingConfig(channel.id, prev => ({
                              ...prev,
                              bind_private: nextChecked,
                            }))
                            if (nextChecked && !privateBound) {
                              setPrivateBindingDialogChannel(channel.id)
                            }
                          }}
                        />
                        <Label htmlFor={`bind-private-${channel.id}`} className="text-sm">
                          {t('notification_settings.bind_private', '绑定到私聊')}
                        </Label>
                        {config.bind_private && !privateBound && (
                          <span className="text-xs text-destructive">
                            {t('notification_settings.private_bind_required')}
                          </span>
                        )}
                      </div>

                      {/* Group chat binding */}
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id={`bind-group-${channel.id}`}
                            checked={config.bind_group}
                            onCheckedChange={checked => {
                              const nextChecked = Boolean(checked)
                              updateBindingConfig(channel.id, prev => ({
                                ...prev,
                                bind_group: nextChecked,
                              }))
                              if (nextChecked) {
                                setGroupBindingDialogChannel(channel.id)
                              } else {
                                void onCancelBinding(channel.id)
                              }
                            }}
                          />
                          <Label htmlFor={`bind-group-${channel.id}`} className="text-sm">
                            {t('notification_settings.bind_group', '绑定到群聊')}
                          </Label>
                        </div>

                        {/* Group binding status card - shown when bind_group is checked */}
                        {config.bind_group && (
                          <div className="pl-6">
                            <GroupBindingCard
                              channelId={channel.id}
                              channelName={channel.name}
                              config={config}
                              isWaiting={isWaiting}
                              onStartBinding={() => {
                                setGroupBindingDialogChannel(channel.id)
                              }}
                              onCancelBinding={() => {
                                void onCancelBinding(channel.id)
                              }}
                              onRebind={() => {
                                void handleRebind(channel.id)
                              }}
                              onUnbind={() => {
                                void handleUnbind(channel.id)
                              }}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
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

      {/* Private binding dialog with step indicators */}
      <Dialog
        open={privateBindingDialogChannel !== null}
        onOpenChange={open => {
          if (!open && privateBindingDialogChannel) {
            void onCancelBinding(privateBindingDialogChannel)
            setPrivateBindingDialogChannel(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('notification_settings.bind_private_title')}</DialogTitle>
            <DialogDescription>{t('notification_settings.bind_private_desc')}</DialogDescription>
          </DialogHeader>

          {/* Step indicators */}
          <div className="py-4">
            <div className="flex items-center justify-center gap-2">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-white text-sm font-medium">
                  1
                </div>
                <span className="text-sm text-text-primary">
                  {t('notification_settings.step_start', '开始绑定')}
                </span>
              </div>
              <div className="w-8 h-px bg-border" />
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-surface border border-border text-sm font-medium text-text-muted">
                  2
                </div>
                <span className="text-sm text-text-muted">
                  {t('notification_settings.step_send_message', '发送消息')}
                </span>
              </div>
              <div className="w-8 h-px bg-border" />
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-surface border border-border text-sm font-medium text-text-muted">
                  3
                </div>
                <span className="text-sm text-text-muted">
                  {t('notification_settings.step_complete', '完成绑定')}
                </span>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                if (privateBindingDialogChannel) {
                  void onCancelBinding(privateBindingDialogChannel)
                }
                setPrivateBindingDialogChannel(null)
              }}
            >
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (privateBindingDialogChannel) {
                  const config = getBindingConfig(privateBindingDialogChannel)
                  void onStartBinding(
                    privateBindingDialogChannel,
                    config.bind_private,
                    config.bind_group
                  )
                }
                setPrivateBindingDialogChannel(null)
              }}
            >
              {t('notification_settings.start_waiting')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Group binding dialog with circular indicator */}
      <Dialog
        open={groupBindingDialogChannel !== null}
        onOpenChange={open => {
          if (!open) {
            if (groupBindingDialogChannel) {
              void onCancelBinding(groupBindingDialogChannel)
            }
            setGroupBindingDialogChannel(null)
            setGroupBindingState('idle')
          }
        }}
      >
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{t('notification_settings.bind_group_title')}</DialogTitle>
          </DialogHeader>

          {/* Circular binding indicator */}
          <div className="flex flex-col items-center py-6">
            {/* Step instructions - always visible */}
            <div className="w-full px-4 mb-6">
              <div className="space-y-3">
                {/* Step 1: Add bot to group */}
                <div className="flex items-start gap-3">
                  <div
                    className={`flex h-6 w-6 items-center justify-center rounded-full text-sm font-medium shrink-0 transition-colors ${
                      groupBindingState === 'idle'
                        ? 'bg-primary text-white'
                        : 'bg-success/10 text-success'
                    }`}
                  >
                    {groupBindingState === 'idle' ? '1' : '✓'}
                  </div>
                  <div className="flex-1">
                    <p
                      className={`text-sm transition-colors ${
                        groupBindingState === 'idle'
                          ? 'text-text-primary font-medium'
                          : 'text-text-muted'
                      }`}
                    >
                      {replaceVariables(
                        bindConfig.steps[0]?.title || '',
                        bindConfig.variables || {}
                      )}
                    </p>
                    {bindConfig.steps[0]?.hint && (
                      <p className="text-xs text-text-muted mt-0.5">
                        {replaceVariables(bindConfig.steps[0].hint, bindConfig.variables || {})}
                      </p>
                    )}
                  </div>
                </div>

                {/* Step 2: Click start */}
                <div className="flex items-start gap-3">
                  <div
                    className={`flex h-6 w-6 items-center justify-center rounded-full text-sm font-medium shrink-0 transition-colors ${
                      groupBindingState === 'waiting'
                        ? 'bg-success/10 text-success'
                        : 'bg-primary/10 text-primary'
                    }`}
                  >
                    {groupBindingState === 'waiting' ? '✓' : '2'}
                  </div>
                  <div className="flex-1">
                    <p
                      className={`text-sm transition-colors ${
                        groupBindingState === 'waiting' ? 'text-text-muted' : 'text-text-primary'
                      }`}
                    >
                      {replaceVariables(
                        bindConfig.steps[1]?.title || '',
                        bindConfig.variables || {}
                      )}
                    </p>
                    {bindConfig.steps[1]?.hint && (
                      <p className="text-xs text-text-muted mt-0.5">
                        {replaceVariables(bindConfig.steps[1].hint, bindConfig.variables || {})}
                      </p>
                    )}
                  </div>
                </div>

                {/* Step 3: @ bot in group */}
                <div className="flex items-start gap-3">
                  <div
                    className={`flex h-6 w-6 items-center justify-center rounded-full text-sm font-medium shrink-0 transition-colors ${
                      groupBindingState === 'waiting'
                        ? 'bg-primary text-white'
                        : 'bg-primary/10 text-primary'
                    }`}
                  >
                    3
                  </div>
                  <div className="flex-1">
                    <p
                      className={`text-sm transition-colors ${
                        groupBindingState === 'waiting'
                          ? 'text-text-primary font-medium'
                          : 'text-text-muted'
                      }`}
                    >
                      {replaceVariables(
                        bindConfig.steps[2]?.title || '',
                        bindConfig.variables || {}
                      )}
                    </p>
                    {bindConfig.steps[2]?.hint && (
                      <p className="text-xs text-text-muted mt-0.5">
                        {replaceVariables(bindConfig.steps[2].hint, bindConfig.variables || {})}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Idle state - clickable circle */}
            {groupBindingState === 'idle' && (
              <>
                <button
                  onClick={() => {
                    if (groupBindingDialogChannel) {
                      setGroupBindingState('waiting')
                      const config = getBindingConfig(groupBindingDialogChannel)
                      void onStartBinding(
                        groupBindingDialogChannel,
                        config.bind_private,
                        config.bind_group
                      )
                    }
                  }}
                  className="relative w-36 h-36 rounded-full border-3 border-primary bg-surface flex flex-col items-center justify-center cursor-pointer transition-all duration-300 hover:scale-105 hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
                  style={{ borderWidth: '3px' }}
                >
                  <span className="text-lg font-semibold text-primary">开始绑定</span>
                </button>
                <Button
                  variant="outline"
                  className="mt-6"
                  onClick={() => {
                    if (groupBindingDialogChannel) {
                      void onCancelBinding(groupBindingDialogChannel)
                    }
                    setGroupBindingDialogChannel(null)
                    setGroupBindingState('idle')
                  }}
                >
                  {t('common:actions.cancel')}
                </Button>
              </>
            )}

            {/* Waiting state - spinning circle */}
            {groupBindingState === 'waiting' && (
              <>
                <div className="relative w-36 h-36">
                  {/* Spinning border */}
                  <div
                    className="absolute inset-0 rounded-full border-3 border-primary/20"
                    style={{ borderWidth: '3px' }}
                  />
                  <div
                    className="absolute inset-0 rounded-full border-3 border-transparent border-t-primary animate-spin"
                    style={{ borderWidth: '3px' }}
                  />
                  {/* Inner content */}
                  <div className="absolute inset-2 rounded-full bg-surface flex flex-col items-center justify-center">
                    <span className="text-sm font-medium text-text-primary mb-1">
                      等待绑定中...
                    </span>
                    <span className="text-xs text-text-muted text-center px-3 leading-relaxed">
                      请在群聊中
                      <br />
                      @机器人发送消息
                    </span>
                  </div>
                </div>
                <Button
                  variant="outline"
                  className="mt-6"
                  onClick={() => {
                    if (groupBindingDialogChannel) {
                      void onCancelBinding(groupBindingDialogChannel)
                    }
                    setGroupBindingState('idle')
                  }}
                >
                  {t('common:actions.cancel')}
                </Button>
              </>
            )}

            {/* Success state - checkmark circle */}
            {groupBindingState === 'success' && (
              <div
                className="relative w-36 h-36 rounded-full border-3 border-success bg-surface flex flex-col items-center justify-center"
                style={{ borderWidth: '3px' }}
              >
                <CheckCircle className="h-10 w-10 text-success mb-1" />
                <span className="text-lg font-semibold text-success">绑定成功!</span>
                {boundGroupName && (
                  <span className="text-xs text-text-muted text-center px-3 truncate max-w-[120px] mt-1">
                    {boundGroupName}
                  </span>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </CollapsibleSection>
  )
}
