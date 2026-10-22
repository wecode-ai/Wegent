// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/hooks/useTranslation'

export interface DingTalkNotificationCardConfig {
  enabled: boolean
  template_id: string
}

export const emptyNotificationCard: DingTalkNotificationCardConfig = {
  enabled: false,
  template_id: '',
}

export function readNotificationCardConfig(value: unknown): DingTalkNotificationCardConfig {
  if (!value || typeof value !== 'object') return { ...emptyNotificationCard }
  const templateId = (value as { template_id?: unknown }).template_id
  return {
    enabled: true,
    template_id: typeof templateId === 'string' ? templateId : '',
  }
}

export function serializeNotificationCardConfig(
  value: DingTalkNotificationCardConfig
): { template_id?: string } | null {
  if (!value.enabled) return null
  const templateId = value.template_id.trim()
  // An empty field leaves the template to the backend, which pushes DingTalk's
  // built-in markdown card; naming one here would pin the AI card instead.
  return templateId ? { template_id: templateId } : {}
}

export default function DingTalkNotificationCardFields({
  value,
  onChange,
  idPrefix,
}: {
  value: DingTalkNotificationCardConfig
  onChange: (value: DingTalkNotificationCardConfig) => void
  idPrefix: string
}) {
  const { t } = useTranslation('admin')
  const key = 'im_channels.notification_card'

  return (
    <details className="space-y-3 rounded-lg border border-border p-4">
      <summary
        className="min-h-11 cursor-pointer text-sm font-medium leading-[44px]"
        data-testid={`${idPrefix}-notification-card-settings`}
      >
        {t(`${key}.title`)}
      </summary>
      <div className="flex min-h-11 items-center justify-between gap-4">
        <Label htmlFor={`${idPrefix}-notification-card-enabled`}>{t(`${key}.enabled`)}</Label>
        <Switch
          id={`${idPrefix}-notification-card-enabled`}
          data-testid={`${idPrefix}-notification-card-enabled`}
          checked={value.enabled}
          onCheckedChange={enabled => onChange({ ...value, enabled })}
        />
      </div>
      {value.enabled && (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-notification-card-template`}>
            {t(`${key}.template_id`)}
          </Label>
          <Input
            id={`${idPrefix}-notification-card-template`}
            data-testid={`${idPrefix}-notification-card-template`}
            value={value.template_id}
            maxLength={128}
            placeholder={t(`${key}.template_placeholder`)}
            onChange={event => onChange({ ...value, template_id: event.target.value })}
          />
          <p className="text-xs text-text-muted">{t(`${key}.help`)}</p>
        </div>
      )}
    </details>
  )
}
