'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Notification Section - Notification level, channels, and webhooks
 */

import { Bell } from 'lucide-react'
import { useMemo, useState, useEffect, useCallback } from 'react'

import { CollapsibleSection } from '@/components/common/CollapsibleSection'
import { Label } from '@/components/ui/label'
import { fetchRuntimeConfig, DEFAULT_BIND_GROUP_STEPS } from '@/lib/runtime-config'
import { useTranslation } from '@/hooks/useTranslation'
import type { NotificationChannelBindingConfig, NotificationLevel } from '@/types/subscription'
import type { NotificationSectionProps } from './types'
import { BindingProgressDialog } from './BindingProgressDialog'
import { ChannelBindingPanel } from './notification-section/ChannelBindingPanel'
import { NotificationChannelCard } from './notification-section/NotificationChannelCard'
import { NotificationLevelSelector } from './notification-section/NotificationLevelSelector'
import { WebhookListEditor } from './notification-section/WebhookListEditor'

interface BindGroupStep {
  title: string
  hint?: string
}

interface BindGroupConfig {
  variables?: Record<string, string>
  steps: BindGroupStep[]
}

const defaultBindConfig: BindGroupConfig = JSON.parse(DEFAULT_BIND_GROUP_STEPS)

const replaceVariables = (text: string, variables: Record<string, string>): string => {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] || `{{${key}}}`)
}

const levelOptionFallbacks: Record<NotificationLevel, { label: string; description: string }> = {
  silent: {
    label: '静默',
    description: '执行但不在时间线显示',
  },
  default: {
    label: '默认',
    description: '在动态时间线中显示',
  },
  notify: {
    label: '通知',
    description: '通过 Messager 渠道发送通知',
  },
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
  const [privateBindingState, setPrivateBindingState] = useState<'idle' | 'waiting' | 'success'>(
    'idle'
  )
  const [boundPrivateName, setBoundPrivateName] = useState<string>('')
  const [groupBindingDialogChannel, setGroupBindingDialogChannel] = useState<number | null>(null)
  const [groupBindingState, setGroupBindingState] = useState<'idle' | 'waiting' | 'success'>('idle')
  const [boundGroupName, setBoundGroupName] = useState<string>('')
  const [bindConfig, setBindConfig] = useState<BindGroupConfig>(defaultBindConfig)

  useEffect(() => {
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
        // Fall through to runtime config.
      }
    }

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
            // Keep default binding config.
          }
        }
      })
      .catch(() => {
        // Keep default binding config.
      })
  }, [])

  const selectedDingtalkChannels = useMemo(() => {
    return devAvailableChannels.filter(
      channel => channel.channel_type === 'dingtalk' && devNotificationChannels.includes(channel.id)
    )
  }, [devAvailableChannels, devNotificationChannels])

  const levelOptions = useMemo(
    () =>
      (['silent', 'default', 'notify'] as NotificationLevel[]).map(level => ({
        value: level,
        label: t(`notification_level.${level}`, levelOptionFallbacks[level].label),
        description: t(
          `notification_settings.level_${level}_desc`,
          levelOptionFallbacks[level].description
        ),
      })),
    [t]
  )

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

  const getChannelName = useCallback(
    (channelId: number) => devAvailableChannels.find(item => item.id === channelId)?.name || '',
    [devAvailableChannels]
  )

  useEffect(() => {
    if (privateBindingDialogChannel && privateBindingState === 'waiting') {
      const channel = devAvailableChannels.find(item => item.id === privateBindingDialogChannel)
      if (channel?.is_bound) {
        setBoundPrivateName(getChannelName(privateBindingDialogChannel))
        setPrivateBindingState('success')
        const timeoutId = window.setTimeout(() => {
          setPrivateBindingDialogChannel(null)
          setPrivateBindingState('idle')
        }, 1500)

        return () => {
          window.clearTimeout(timeoutId)
        }
      }
    }
  }, [privateBindingDialogChannel, privateBindingState, getChannelName, devAvailableChannels])

  useEffect(() => {
    if (groupBindingDialogChannel && groupBindingState === 'waiting') {
      const config = getBindingConfig(groupBindingDialogChannel)
      if (config.group_conversation_id) {
        setBoundGroupName(config.group_name || '')
        setGroupBindingState('success')
        const timeoutId = window.setTimeout(() => {
          setGroupBindingDialogChannel(null)
          setGroupBindingState('idle')
        }, 1500)

        return () => {
          window.clearTimeout(timeoutId)
        }
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

  const clearGroupBinding = (channelId: number) => {
    setChannelBindingConfigs((prev: NotificationChannelBindingConfig[]) => {
      const existing = prev.find(
        (cfg: NotificationChannelBindingConfig) => cfg.channel_id === channelId
      )
      if (!existing) {
        return prev
      }

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

  const handleStartGroupBinding = async (channelId: number) => {
    const config = getBindingConfig(channelId)
    await onStartBinding(channelId, config.bind_private, config.bind_group)
  }

  const handleRebind = async (channelId: number) => {
    clearGroupBinding(channelId)
    await handleStartGroupBinding(channelId)
  }

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
      title={t('notification_settings.title', '通知设置')}
      icon={<Bell className="h-4 w-4 text-primary" />}
      defaultOpen={true}
    >
      <div className="space-y-4">
        <NotificationLevelSelector
          label={t('notification_settings.level_label', '通知级别')}
          value={devNotificationLevel}
          options={levelOptions}
          disabled={devSettingsLoading}
          onChange={setDevNotificationLevel}
        />

        {devNotificationLevel === 'notify' && (
          <section className="space-y-4 rounded-xl border border-border bg-surface/40 p-4">
            <div className="space-y-1">
              <Label className="text-sm font-medium">
                {t('notification_settings.channels_label', '通知渠道')}
              </Label>
              <p className="text-xs text-text-muted">选择要接收即时通知的渠道</p>
            </div>

            {devAvailableChannels.length > 0 ? (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {devAvailableChannels.map(channel => (
                  <NotificationChannelCard
                    key={channel.id}
                    channel={channel}
                    selected={devNotificationChannels.includes(channel.id)}
                    disabled={devSettingsLoading}
                    onToggle={() => {
                      setDevNotificationChannels(prev =>
                        prev.includes(channel.id)
                          ? prev.filter(id => id !== channel.id)
                          : [...prev, channel.id]
                      )
                    }}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border bg-background px-4 py-5">
                <p className="text-xs text-text-muted">
                  {t('notification_settings.no_channels', '暂无可用的 Messager 渠道')}
                </p>
              </div>
            )}

            {selectedDingtalkChannels.length > 0 && (
              <div className="space-y-3" data-testid="notification-channel-config-section">
                <div className="space-y-1">
                  <Label className="text-sm font-medium">钉钉通知配置</Label>
                  <p className="text-xs text-text-muted">
                    {t(
                      'notification_settings.channel_target_description',
                      '配置此渠道的通知投递目标'
                    )}
                  </p>
                </div>

                {selectedDingtalkChannels.map(channel => {
                  const config = getBindingConfig(channel.id)
                  const privateBound = getPrivateBound(channel.id)
                  const isWaiting = bindingWaitingState[channel.id] ?? false

                  return (
                    <ChannelBindingPanel
                      key={channel.id}
                      channelId={channel.id}
                      config={config}
                      privateBound={privateBound}
                      isWaiting={isWaiting}
                      onPrivateChange={checked => {
                        updateBindingConfig(channel.id, prev => ({
                          ...prev,
                          bind_private: checked,
                        }))
                        if (checked && !privateBound) {
                          setPrivateBindingState('idle')
                          setBoundPrivateName('')
                          setPrivateBindingDialogChannel(channel.id)
                        }
                      }}
                      onStartPrivateBinding={() => {
                        setPrivateBindingState('idle')
                        setBoundPrivateName('')
                        setPrivateBindingDialogChannel(channel.id)
                      }}
                      onGroupChange={checked => {
                        updateBindingConfig(channel.id, prev => ({
                          ...prev,
                          bind_group: checked,
                        }))
                        if (checked) {
                          if (config.group_conversation_id) {
                            setGroupBindingDialogChannel(null)
                            setGroupBindingState('idle')
                            setBoundGroupName(config.group_name || '')
                          } else {
                            setGroupBindingState('idle')
                            setBoundGroupName('')
                            setGroupBindingDialogChannel(channel.id)
                          }
                        } else {
                          void onCancelBinding(channel.id)
                        }
                      }}
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
                  )
                })}
              </div>
            )}
          </section>
        )}

        <WebhookListEditor
          notificationWebhooks={notificationWebhooks}
          setNotificationWebhooks={setNotificationWebhooks}
        />

        {devSettingsLoading && <p className="text-xs text-text-muted">{t('common:loading')}</p>}
      </div>

      <BindingProgressDialog
        open={privateBindingDialogChannel !== null}
        title={t('notification_settings.bind_private_title', '绑定到私聊')}
        description={t(
          'notification_settings.bind_private_desc',
          '请在钉钉私聊机器人发送任意消息，系统将自动完成绑定。'
        )}
        state={privateBindingState}
        steps={[
          { title: t('notification_settings.step_start', '开始绑定') },
          {
            title: t('notification_settings.step_send_message', '发送消息'),
            hint: t(
              'notification_settings.bind_private_desc',
              '请在钉钉私聊机器人发送任意消息，系统将自动完成绑定。'
            ),
          },
          { title: t('notification_settings.step_complete', '完成绑定') },
        ]}
        startLabel={t('notification_settings.step_start', '开始绑定')}
        waitingTitle={t('notification_settings.waiting_binding', '正在等待绑定...')}
        waitingHint={t(
          'notification_settings.bind_private_desc',
          '请在钉钉私聊机器人发送任意消息，系统将自动完成绑定。'
        )}
        successTitle={t('notification_settings.binding_success', '绑定成功')}
        successHint={boundPrivateName}
        cancelLabel={t('common:actions.cancel')}
        startTestId="private-binding-start-button"
        onStart={() => {
          if (privateBindingDialogChannel) {
            setPrivateBindingState('waiting')
            const config = getBindingConfig(privateBindingDialogChannel)
            void onStartBinding(privateBindingDialogChannel, true, config.bind_group)
          }
        }}
        onCancel={() => {
          if (privateBindingDialogChannel) {
            void onCancelBinding(privateBindingDialogChannel)
          }
          setPrivateBindingDialogChannel(null)
          setPrivateBindingState('idle')
        }}
        onOpenChange={open => {
          if (!open) {
            if (privateBindingState !== 'success' && privateBindingDialogChannel) {
              void onCancelBinding(privateBindingDialogChannel)
            }
            setPrivateBindingDialogChannel(null)
            setPrivateBindingState('idle')
          }
        }}
      />

      <BindingProgressDialog
        open={groupBindingDialogChannel !== null}
        title={t('notification_settings.bind_group_title', '绑定到群聊')}
        description={t(
          'notification_settings.bind_group_desc',
          '请将机器人加入目标群，在群里 @机器人 发送一条消息，系统会自动绑定并保持等待中状态。'
        )}
        state={groupBindingState}
        steps={bindConfig.steps.slice(0, 3).map(step => ({
          title: replaceVariables(step.title || '', bindConfig.variables || {}),
          hint: step.hint ? replaceVariables(step.hint, bindConfig.variables || {}) : undefined,
        }))}
        startLabel={t('notification_settings.step_start', '开始绑定')}
        waitingTitle={t('notification_settings.group_binding_waiting_title', '正在等待群聊消息...')}
        waitingHint={t(
          'notification_settings.group_binding_waiting_desc',
          '请在群聊中 @机器人 发送任意消息'
        )}
        successTitle={t('notification_settings.binding_success', '绑定成功')}
        successHint={boundGroupName}
        cancelLabel={t('common:actions.cancel')}
        startTestId="group-binding-start-button"
        onStart={() => {
          if (groupBindingDialogChannel) {
            setGroupBindingState('waiting')
            const config = getBindingConfig(groupBindingDialogChannel)
            void onStartBinding(groupBindingDialogChannel, config.bind_private, config.bind_group)
          }
        }}
        onCancel={() => {
          if (groupBindingDialogChannel) {
            void onCancelBinding(groupBindingDialogChannel)
          }
          setGroupBindingDialogChannel(null)
          setGroupBindingState('idle')
        }}
        onOpenChange={open => {
          if (!open) {
            if (groupBindingState !== 'success' && groupBindingDialogChannel) {
              void onCancelBinding(groupBindingDialogChannel)
            }
            setGroupBindingDialogChannel(null)
            setGroupBindingState('idle')
          }
        }}
        contentClassName="sm:max-w-[400px]"
      />
    </CollapsibleSection>
  )
}
