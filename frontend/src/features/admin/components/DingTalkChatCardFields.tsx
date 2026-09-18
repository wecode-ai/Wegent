// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/hooks/useTranslation'

export interface DingTalkChatCardConfig {
  template_id: string
  content_key: string
  follow_up_enabled: boolean
  follow_up_action: string
  follow_up_text_key: string
  follow_up_images_key: string
  follow_up_status_key?: string | null
  initial_data?: Record<string, string>
}

export const emptyChatCard: DingTalkChatCardConfig = {
  template_id: '',
  content_key: 'content',
  follow_up_enabled: true,
  follow_up_action: 'follow_up',
  follow_up_text_key: 'followUpText',
  follow_up_images_key: 'followUpImages',
  follow_up_status_key: null,
}

export function readChatCardConfig(value: unknown): DingTalkChatCardConfig {
  if (!value || typeof value !== 'object') return { ...emptyChatCard }
  return { ...emptyChatCard, ...(value as Partial<DingTalkChatCardConfig>) }
}

export function serializeChatCardConfig(
  value: DingTalkChatCardConfig
): DingTalkChatCardConfig | null {
  if (!value.template_id.trim()) return null
  return {
    ...value,
    template_id: value.template_id.trim(),
    content_key: value.content_key.trim() || emptyChatCard.content_key,
    follow_up_action: value.follow_up_action.trim() || emptyChatCard.follow_up_action,
    follow_up_text_key: value.follow_up_text_key.trim() || emptyChatCard.follow_up_text_key,
    follow_up_images_key: value.follow_up_images_key.trim() || emptyChatCard.follow_up_images_key,
    follow_up_status_key: value.follow_up_status_key?.trim() || null,
  }
}

export default function DingTalkChatCardFields({
  value,
  onChange,
  idPrefix,
}: {
  value: DingTalkChatCardConfig
  onChange: (value: DingTalkChatCardConfig) => void
  idPrefix: string
}) {
  const { t } = useTranslation('admin')
  const key = 'im_channels.chat_card'
  const textFields = value.follow_up_enabled
    ? ([
        'content_key',
        'follow_up_action',
        'follow_up_text_key',
        'follow_up_images_key',
        'follow_up_status_key',
      ] as const)
    : (['content_key'] as const)

  return (
    <details className="space-y-3 rounded-lg border border-border p-4">
      <summary
        className="min-h-11 cursor-pointer text-sm font-medium leading-[44px]"
        data-testid={`${idPrefix}-chat-card-settings`}
      >
        {t(`${key}.title`)}
      </summary>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-chat-card-template`}>{t(`${key}.template_id`)}</Label>
        <Input
          id={`${idPrefix}-chat-card-template`}
          data-testid={`${idPrefix}-chat-card-template`}
          value={value.template_id}
          maxLength={128}
          placeholder={t(`${key}.template_placeholder`)}
          onChange={event => onChange({ ...value, template_id: event.target.value })}
        />
        <p className="text-xs text-text-muted">{t(`${key}.help`)}</p>
      </div>
      {value.template_id.trim() && (
        <details className="space-y-3">
          <summary
            className="min-h-11 cursor-pointer text-sm leading-[44px]"
            data-testid={`${idPrefix}-chat-card-advanced`}
          >
            {t(`${key}.advanced`)}
          </summary>
          <div className="flex min-h-11 items-center justify-between gap-4">
            <Label htmlFor={`${idPrefix}-chat-card-follow-up`}>
              {t(`${key}.follow_up_enabled`)}
            </Label>
            <Switch
              id={`${idPrefix}-chat-card-follow-up`}
              data-testid={`${idPrefix}-chat-card-follow-up`}
              checked={value.follow_up_enabled}
              onCheckedChange={checked => onChange({ ...value, follow_up_enabled: checked })}
            />
          </div>
          {textFields.map(field => (
            <div className="space-y-2" key={field}>
              <Label htmlFor={`${idPrefix}-chat-card-${field}`}>{t(`${key}.${field}`)}</Label>
              <Input
                id={`${idPrefix}-chat-card-${field}`}
                data-testid={`${idPrefix}-chat-card-${field}`}
                value={value[field] ?? ''}
                placeholder={emptyChatCard[field] ?? ''}
                maxLength={128}
                onChange={event => onChange({ ...value, [field]: event.target.value })}
              />
            </div>
          ))}
          <p className="text-xs text-text-muted">{t(`${key}.mapping_help`)}</p>
        </details>
      )}
    </details>
  )
}
