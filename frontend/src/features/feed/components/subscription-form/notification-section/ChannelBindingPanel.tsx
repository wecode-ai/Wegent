'use client'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/hooks/useTranslation'
import type { NotificationChannelBindingConfig } from '@/types/subscription'
import type { TFunction } from 'i18next'

interface ChannelBindingPanelProps {
  channelId: number
  config: NotificationChannelBindingConfig
  privateBound: boolean
  isWaiting: boolean
  onPrivateChange: (checked: boolean) => void
  onGroupChange: (checked: boolean) => void
  onStartPrivateBinding: () => void
  onStartBinding: () => void
  onCancelBinding: () => void
  onRebind: () => void
  onUnbind: () => void
}

const resolvePrivateStatusText = (bound: boolean, t: TFunction<string | string[]>) => {
  if (bound) {
    return `${t('notification_settings.bound_to_prefix', '已绑定至：')}${t(
      'notification_settings.bound_private_target',
      '当前私聊会话'
    )}`
  }

  return t('notification_settings.unbound_status', '尚未绑定')
}

const resolveGroupStatusText = (
  waiting: boolean,
  bound: boolean,
  groupName: string | undefined,
  t: TFunction<string | string[]>
) => {
  if (waiting) {
    return t('notification_settings.binding_pending', '等待绑定中...')
  }

  if (bound) {
    return `${t('notification_settings.bound_to_prefix', '已绑定至：')}${groupName || ''}`
  }

  return t('notification_settings.unbound_status', '尚未绑定')
}

export function ChannelBindingPanel({
  channelId,
  config,
  privateBound,
  isWaiting,
  onPrivateChange,
  onGroupChange,
  onStartPrivateBinding,
  onStartBinding,
  onCancelBinding,
  onRebind,
  onUnbind,
}: ChannelBindingPanelProps) {
  const { t } = useTranslation('feed')
  const groupBound = Boolean(config.group_conversation_id)
  const privateStatusText = resolvePrivateStatusText(privateBound, t)
  const groupStatusText = resolveGroupStatusText(isWaiting, groupBound, config.group_name, t)
  const privateTitle = config.bind_private
    ? t('notification_settings.private_delivery_enabled', '已启用私聊')
    : t('notification_settings.private_delivery_disabled', '未启用私聊')
  const groupTitle = config.bind_group
    ? t('notification_settings.group_delivery_enabled', '已启用群聊')
    : t('notification_settings.group_delivery_disabled', '未启用群聊')

  return (
    <div
      className="space-y-4 rounded-xl border border-border bg-background p-4"
      data-testid={`notification-channel-config-${channelId}`}
    >
      <div className="space-y-3">
        <div className="rounded-lg border border-border bg-surface/40 p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <Label
                htmlFor={`enable-private-${channelId}`}
                className="text-base font-semibold text-text-primary"
                data-testid={`private-delivery-title-${channelId}`}
              >
                {privateTitle}
              </Label>
              <p
                className="text-sm font-medium text-text-primary"
                data-testid={`private-delivery-status-${channelId}`}
              >
                {privateStatusText}
              </p>
              <p className="text-xs text-text-muted">
                {t(
                  'notification_settings.private_delivery_hint',
                  '开启后，通知会发送到与机器人绑定的私聊会话'
                )}
              </p>
            </div>
            <Switch
              id={`enable-private-${channelId}`}
              checked={config.bind_private}
              onCheckedChange={onPrivateChange}
              aria-label={privateTitle}
            />
          </div>

          {config.bind_private && !privateBound && (
            <div className="mt-3 flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={onStartPrivateBinding}
              >
                {t('notification_settings.bind_now', '去绑定')}
              </Button>
              <p className="text-xs text-destructive">
                {t('notification_settings.private_bind_required', '未绑定，请先完成绑定')}
              </p>
            </div>
          )}
        </div>

        <div className="rounded-lg border border-border bg-surface/40 p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <Label
                htmlFor={`enable-group-${channelId}`}
                className="text-base font-semibold text-text-primary"
                data-testid={`group-delivery-title-${channelId}`}
              >
                {groupTitle}
              </Label>
              <p
                className="text-sm font-medium text-text-primary"
                data-testid={`group-delivery-status-${channelId}`}
              >
                {groupStatusText}
              </p>
              <p className="text-xs text-text-muted">
                {isWaiting
                  ? t(
                      'notification_settings.group_binding_waiting_desc',
                      '请在群聊中 @机器人 发送任意消息'
                    )
                  : t(
                      'notification_settings.group_delivery_hint',
                      '开启后，通知会发送到当前已绑定的群聊会话'
                    )}
              </p>
            </div>
            <Switch
              id={`enable-group-${channelId}`}
              checked={config.bind_group}
              onCheckedChange={onGroupChange}
              aria-label={groupTitle}
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {isWaiting ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={onCancelBinding}
              >
                {t('common:actions.cancel')}
              </Button>
            ) : groupBound ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={onRebind}
                >
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
              </>
            ) : config.bind_group ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={onStartBinding}
              >
                {t('notification_settings.bind_now', '去绑定')}
              </Button>
            ) : null}
          </div>

          {groupBound && config.group_conversation_id && (
            <p className="mt-2 text-xs text-text-muted">
              ID: {config.group_conversation_id.slice(0, 20)}
              {config.group_conversation_id.length > 20 ? '...' : ''}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
