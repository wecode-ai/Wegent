'use client'

import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Calendar, CheckCircle2, Clock, XCircle, Bell, Settings } from 'lucide-react'
import { toast } from 'sonner'

interface SubscriptionPreviewConfig {
  display_name: string
  description?: string
  trigger_type: 'cron' | 'interval' | 'one_time'
  trigger_display: string
  prompt_preview: string
  preserve_history: boolean
  history_message_count: number
  retry_count: number
  timeout_seconds: number
  expires_at?: string
}

export interface SubscriptionPreviewBlock {
  type: 'subscription_preview'
  preview_id: string
  execution_id: string
  task_id: number
  subtask_id: number
  tool_use_id?: string
  config: SubscriptionPreviewConfig
  created_at: string
  status:
    | 'pending'
    | 'confirmed'
    | 'cancelled'
    | 'expired'
    | 'done'
    | 'error'
    | 'streaming'
    | undefined
}

interface SubscriptionPreviewCardProps {
  data: SubscriptionPreviewBlock
}

export function SubscriptionPreviewCard({ data }: SubscriptionPreviewCardProps) {
  const { t } = useTranslation('subscription')
  const [status, setStatus] = useState(data.status)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    const createdAt = new Date(data.created_at).getTime()
    const ttl = 86400 * 1000
    const expireAt = createdAt + ttl

    const checkExpired = () => {
      const now = Date.now()
      if (now >= expireAt && status === 'pending') {
        setStatus('expired')
      }
    }

    checkExpired()
    const interval = setInterval(checkExpired, 60000)
    return () => clearInterval(interval)
  }, [data.created_at, status])

  const handleConfirm = async () => {
    if (status !== 'pending') return

    setIsLoading(true)
    try {
      const response = await fetch(`/api/subscriptions/preview/${data.preview_id}/confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.detail || 'Failed to create subscription')
      }

      const result = await response.json()
      setStatus('confirmed')
      toast.success(t('preview.create_success', { name: result.display_name }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('preview.create_error'))
    } finally {
      setIsLoading(false)
    }
  }

  const handleCancel = () => {
    setStatus('cancelled')
    toast.info(t('preview.cancelled'))
  }

  const formatExpiration = (expiresAt?: string) => {
    if (!expiresAt) return ''
    const date = new Date(expiresAt)
    const now = new Date()
    const diffDays = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    return diffDays > 0 ? `${diffDays}天后过期` : '即将过期'
  }

  const formatTimeout = (seconds: number) => {
    if (seconds >= 60) {
      return `${Math.floor(seconds / 60)}分钟`
    }
    return `${seconds}秒`
  }

  if (status === 'confirmed') {
    return (
      <Card className="border-border">
        <CardContent className="flex flex-col items-center py-6">
          <div className="w-10 h-10 rounded-full bg-green-50 flex items-center justify-center mb-3">
            <CheckCircle2 className="w-5 h-5 text-green-500" />
          </div>
          <h3 className="text-base font-semibold text-text-primary mb-1">
            {t('preview.confirmed_title')}
          </h3>
          <p className="text-sm text-text-secondary">{t('preview.confirmed_desc')}</p>
        </CardContent>
      </Card>
    )
  }

  if (status === 'cancelled') {
    return (
      <Card className="border-border">
        <CardContent className="flex flex-col items-center py-6">
          <div className="w-10 h-10 rounded-full bg-gray-50 flex items-center justify-center mb-3">
            <XCircle className="w-5 h-5 text-gray-400" />
          </div>
          <h3 className="text-base font-semibold text-text-primary mb-1">
            {t('preview.cancelled_title')}
          </h3>
          <p className="text-sm text-text-secondary">{t('preview.cancelled_desc')}</p>
        </CardContent>
      </Card>
    )
  }

  if (status === 'expired') {
    return (
      <Card className="border-border">
        <CardContent className="flex flex-col items-center py-6">
          <div className="w-10 h-10 rounded-full bg-amber-50 flex items-center justify-center mb-3">
            <Clock className="w-5 h-5 text-amber-500" />
          </div>
          <h3 className="text-base font-semibold text-text-primary mb-1">
            {t('preview.expired_title')}
          </h3>
          <p className="text-sm text-text-secondary">{t('preview.expired_desc')}</p>
        </CardContent>
      </Card>
    )
  }

  const { config } = data

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Calendar className="h-4 w-4 text-primary" />
          {t('preview.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Task Name */}
        <div>
          <h3 className="text-base font-semibold text-text-primary">{config.display_name}</h3>
          <p className="text-xs text-text-secondary mt-0.5">
            {config.trigger_display}
            {config.expires_at && <span> · {formatExpiration(config.expires_at)}</span>}
          </p>
        </div>

        {/* Prompt Content */}
        <div className="rounded-md border border-border bg-surface p-3">
          <div className="flex items-center gap-1.5 text-text-secondary mb-2">
            <Bell className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">{t('preview.prompt')}</span>
          </div>
          <p className="text-sm text-text-primary leading-relaxed">{config.prompt_preview}</p>
        </div>

        {/* Settings */}
        <div className="rounded-md border border-border overflow-hidden">
          <div className="grid grid-cols-2 divide-x divide-border">
            {/* Trigger Settings */}
            <div className="p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-text-secondary">
                <Clock className="h-3.5 w-3.5" />
                <span className="text-xs font-medium">{t('preview.trigger_settings')}</span>
              </div>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-text-secondary">{t('preview.trigger_type')}</span>
                  <span className="text-text-primary font-medium">Cron</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-secondary">{t('preview.cron_expression')}</span>
                  <code className="bg-surface px-1 rounded text-text-primary font-mono">
                    0 12 * * *
                  </code>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-secondary">{t('preview.timezone')}</span>
                  <span className="text-text-primary">Asia/Shanghai</span>
                </div>
              </div>
            </div>

            {/* Execution Settings */}
            <div className="p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-text-secondary">
                <Settings className="h-3.5 w-3.5" />
                <span className="text-xs font-medium">{t('preview.execution_settings')}</span>
              </div>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-text-secondary">{t('preview.preserve_history')}</span>
                  <span className="text-text-primary">
                    {config.preserve_history ? t('common:yes') : t('common:no')}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-secondary">{t('preview.retry')}</span>
                  <span className="text-text-primary">
                    {config.retry_count}
                    {t('common:times')}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-secondary">{t('preview.timeout')}</span>
                  <span className="text-text-primary">{formatTimeout(config.timeout_seconds)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Buttons */}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={handleCancel} disabled={isLoading}>
            {t('preview.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={handleConfirm} disabled={isLoading}>
            {isLoading ? t('common:creating') : t('preview.confirm')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
