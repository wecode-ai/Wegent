import React, { useEffect, useState } from 'react'
import { Coins } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

import { quotaApis, QuotaData } from '@/apis/quota'
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/use-toast'
import { getRuntimeConfigSync } from '@/lib/runtime-config'
import { useChatStatusIndicator } from '@/features/tasks/hooks/useChatStatusIndicator'
import { cn } from '@/lib/utils'

type QuotaUsageProps = {
  className?: string
  // When true, use the tighter trigger sizing for constrained layouts.
  compact?: boolean
}

export default function QuotaUsage({ className, compact = false }: QuotaUsageProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const status = useChatStatusIndicator()
  const enableDisplayQuotas = getRuntimeConfigSync().enableDisplayQuotas
  const [quota, setQuota] = useState<QuotaData | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  const handleLoadQuota = React.useCallback(() => {
    if (!enableDisplayQuotas) {
      return
    }
    setLoading(true)
    setError(null)
    quotaApis
      .fetchQuota()
      .then(data => {
        setQuota(data)
      })
      .catch(() => {
        setError(t('common:quota.load_failed'))
        toast({
          variant: 'destructive',
          title: t('common:quota.load_failed'),
        })
      })
      .finally(() => {
        setLoading(false)
      })
  }, [enableDisplayQuotas, t, toast])

  useEffect(() => {
    if (!enableDisplayQuotas) {
      return
    }
    handleLoadQuota()
  }, [enableDisplayQuotas, handleLoadQuota])

  // Separate effect for polling when quota data is available
  useEffect(() => {
    let timer: NodeJS.Timeout | null = null
    if (enableDisplayQuotas && quota && Object.keys(quota).length > 0) {
      timer = setInterval(() => {
        handleLoadQuota()
      }, 20000)
    }
    return () => {
      if (timer) clearInterval(timer)
    }
  }, [enableDisplayQuotas, quota, handleLoadQuota])

  const showQuotaSection = enableDisplayQuotas && !!quota
  const showStatusSection = status.shouldRender && !!status.display
  const hasVisibleContent = showQuotaSection || showStatusSection

  const quotaHasError = enableDisplayQuotas && !!error && !quota

  if (!enableDisplayQuotas && !showStatusSection) {
    return null
  }

  if (!hasVisibleContent && !showStatusSection) {
    if (loading) {
      return (
        <div className={`flex items-center justify-center mt-1 mb-2 ${className ?? ''}`}>
          <Spinner size="sm" />
        </div>
      )
    }

    return null
  }

  const quotaDetail = quota?.user_quota_detail
  const brief =
    quota && quotaDetail
      ? t('common:quota.brief', {
          quota_source: quota.quota_source,
          monthly_usage: quotaDetail.monthly_usage,
          monthly_quota: quotaDetail.monthly_quota.toLocaleString(),
          permanent_quota: (
            quotaDetail.permanent_quota - quotaDetail.permanent_usage
          ).toLocaleString(),
        })
      : null

  const contentElement = (
    <div className="space-y-3 text-xs" data-testid="chat-meta-popover">
      {showStatusSection && status.display && (
        <section className="space-y-1.5" data-testid="chat-status-section">
          <div className="text-sm font-medium text-text-primary">
            {t('common:chat_status.title')}
          </div>
          <div className="text-sm text-text-primary">
            {t('common:chat_status.context_remaining', {
              percent: status.display.percent,
            })}
          </div>
          <div className="text-text-muted">
            {t('common:chat_status.context_usage', {
              used: status.display.usedTokens,
              total: status.display.totalTokens,
            })}
          </div>
          {status.display.isOverTrigger && (
            <div className="text-amber-700">{t('common:chat_status.over_trigger')}</div>
          )}
        </section>
      )}

      {showQuotaSection && quotaDetail && brief && (
        <section className="space-y-1.5" data-testid="quota-usage-section">
          <div className="text-sm font-medium text-text-primary">{t('common:quota.title')}</div>
          <div className="text-sm text-text-primary">{brief}</div>
          <div className="text-text-muted">
            {t('common:quota.detail_monthly', {
              monthly_quota: quotaDetail.monthly_quota,
              monthly_usage: quotaDetail.monthly_usage,
              monthly_left: quotaDetail.monthly_quota - quotaDetail.monthly_usage,
            })}
          </div>
          <div className="text-text-muted">
            {t('common:quota.detail_permanent', {
              permanent_quota: quotaDetail.permanent_quota,
              permanent_usage: quotaDetail.permanent_usage,
              permanent_left: quotaDetail.permanent_quota - quotaDetail.permanent_usage,
            })}
          </div>
        </section>
      )}

      {quotaHasError && (
        <section className="space-y-1.5" data-testid="quota-error-section">
          <div className="text-sm font-medium text-text-primary">{t('common:quota.title')}</div>
          <div className="text-text-muted">{t('common:quota.load_failed')}</div>
        </section>
      )}
    </div>
  )

  if (compact) {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn('h-6 w-6 flex-shrink-0', className ?? '')}
            data-testid="chat-meta-trigger"
            style={{
              padding: 0,
            }}
          >
            <Coins
              className={cn(
                'h-4 w-4 text-text-muted hover:text-text-primary',
                showStatusSection &&
                  status.display?.isOverTrigger &&
                  'text-amber-700 hover:text-amber-800'
              )}
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent side="bottom" align="end" className="w-64 p-3">
          {contentElement}
        </PopoverContent>
      </Popover>
    )
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className={cn(
            'h-auto gap-1.5 px-0 !text-text-muted hover:!text-text-primary',
            className ?? ''
          )}
          data-testid="chat-meta-trigger"
          style={{
            lineHeight: 'normal',
            color: 'rgb(var(--color-text-muted))',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.color = 'rgb(var(--color-text-primary))'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.color = 'rgb(var(--color-text-muted))'
          }}
        >
          <Coins
            className={cn(
              'h-4 w-4',
              showStatusSection && status.display?.isOverTrigger && 'text-amber-700'
            )}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-64 p-3">
        {contentElement}
      </PopoverContent>
    </Popover>
  )
}
