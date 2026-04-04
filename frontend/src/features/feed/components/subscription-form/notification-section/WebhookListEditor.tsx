'use client'

import { Plus, Trash2 } from 'lucide-react'

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
import { useTranslation } from '@/hooks/useTranslation'
import type { NotificationWebhook, NotificationWebhookType } from '@/types/subscription'

interface WebhookListEditorProps {
  notificationWebhooks: NotificationWebhook[]
  setNotificationWebhooks: React.Dispatch<React.SetStateAction<NotificationWebhook[]>>
}

export function WebhookListEditor({
  notificationWebhooks,
  setNotificationWebhooks,
}: WebhookListEditorProps) {
  const { t } = useTranslation('feed')

  return (
    <section
      className="space-y-4 rounded-xl border border-border bg-surface/40 p-4"
      data-testid="notification-webhook-section"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <Label className="text-sm font-medium">{t('notification_settings.webhook_title')}</Label>
          <p className="text-xs text-text-muted">{t('notification_settings.webhook_hint')}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9"
          onClick={() => {
            setNotificationWebhooks(prev => [
              ...prev,
              { type: 'dingtalk' as NotificationWebhookType, url: '', enabled: true },
            ])
          }}
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          {t('notification_settings.add_webhook')}
        </Button>
      </div>

      {notificationWebhooks.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-background px-4 py-5">
          <p className="text-xs text-text-muted">{t('notification_settings.no_webhooks')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {notificationWebhooks.map((webhook, index) => (
            <div
              key={index}
              className="space-y-3 rounded-lg border border-border bg-background p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Select
                    value={webhook.type}
                    onValueChange={(value: NotificationWebhookType) => {
                      setNotificationWebhooks(prev =>
                        prev.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, type: value } : item
                        )
                      )
                    }}
                  >
                    <SelectTrigger className="h-9 w-[120px]">
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
                  <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
                    <Switch
                      checked={webhook.enabled}
                      onCheckedChange={checked => {
                        setNotificationWebhooks(prev =>
                          prev.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, enabled: checked } : item
                          )
                        )
                      }}
                    />
                    <span className="text-xs text-text-muted">
                      {webhook.enabled ? '已启用' : '未启用'}
                    </span>
                  </div>
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  onClick={() => {
                    setNotificationWebhooks(prev =>
                      prev.filter((_, itemIndex) => itemIndex !== index)
                    )
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>

              <Input
                value={webhook.url}
                onChange={event => {
                  setNotificationWebhooks(prev =>
                    prev.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, url: event.target.value } : item
                    )
                  )
                }}
                placeholder={t('notification_settings.webhook_url_placeholder')}
                className="h-10 text-sm"
              />

              <Input
                value={webhook.secret || ''}
                onChange={event => {
                  setNotificationWebhooks(prev =>
                    prev.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, secret: event.target.value || undefined }
                        : item
                    )
                  )
                }}
                placeholder={t('notification_settings.webhook_secret_placeholder')}
                className="h-10 text-sm"
              />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
