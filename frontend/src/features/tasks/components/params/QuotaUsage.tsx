import React, { useEffect, useState } from 'react'
import { Coins } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

import { quotaApis, QuotaData } from '@/apis/quota'
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/use-toast'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { getRuntimeConfigSync } from '@/lib/runtime-config'

type QuotaUsageProps = {
  className?: string
  // When true, display only an icon instead of full text (for mobile space constraints)
  compact?: boolean
}

export default function QuotaUsage({ className, compact = false }: QuotaUsageProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const isMobile = useIsMobile()
  const [quota, setQuota] = useState<QuotaData | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  const handleLoadQuota = React.useCallback(() => {
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
  }, [t, toast])

  useEffect(() => {
    handleLoadQuota()
  }, [handleLoadQuota])

  // Separate effect for polling when quota data is available
  useEffect(() => {
    let timer: NodeJS.Timeout | null = null
    if (quota && Object.keys(quota).length > 0) {
      timer = setInterval(() => {
        handleLoadQuota()
      }, 20000)
    }
    return () => {
      if (timer) clearInterval(timer)
    }
  }, [quota, handleLoadQuota])

  // Check if quota display is enabled via runtime config
  const enableDisplayQuotas = getRuntimeConfigSync().enableDisplayQuotas
  if (!enableDisplayQuotas) {
    return null
  }

  if (loading && !quota) {
    return (
      <div className={`flex items-center justify-center mt-1 mb-2 ${className ?? ''}`}>
        <Spinner size="sm" />
      </div>
    )
  }

  if (error || !quota) {
    // Don't render anything when there's no data or error (empty objects are handled as null in API)
    if (!quota && !error) {
      return null
    }
    return (
      <div className={`text-xs text-text-muted mt-1 mb-2 ${className ?? ''}`}>
        {error || t('common:quota.load_failed')}
      </div>
    )
  }

  const { monthly_quota, monthly_usage, permanent_quota, permanent_usage } = quota.user_quota_detail

  const brief = t('common:quota.brief', {
    quota_source: quota.quota_source,
    monthly_usage,
    monthly_quota: monthly_quota.toLocaleString(),
    permanent_quota: (permanent_quota - permanent_usage).toLocaleString(),
  })

  const detail = (
    <div>
      <div>
        {t('common:quota.detail_monthly', {
          monthly_quota,
          monthly_usage,
          monthly_left: monthly_quota - monthly_usage,
        })}
      </div>
      <div>
        {t('common:quota.detail_permanent', {
          permanent_quota,
          permanent_usage,
          permanent_left: permanent_quota - permanent_usage,
        })}
      </div>
    </div>
  )
  // Compact mode: show only icon
  // On mobile: use Popover (click to show)
  // On desktop: use Tooltip (hover to show)
  if (compact) {
    const iconButton = (
      <Button
        variant="ghost"
        size="icon"
        className={`h-6 w-6 flex-shrink-0 ${className ?? ''}`}
        style={{
          padding: 0,
        }}
      >
        <Coins className="w-4 h-4 text-text-muted hover:text-text-primary" />
      </Button>
    )

    const contentElement = (
      <div className="text-xs">
        <div className="mb-1">{brief}</div>
        {detail}
      </div>
    )

    // On mobile, use Popover for click-to-show behavior
    if (isMobile) {
      return (
        <Popover>
          <PopoverTrigger asChild>{iconButton}</PopoverTrigger>
          <PopoverContent side="bottom" className="w-auto p-3">
            {contentElement}
          </PopoverContent>
        </Popover>
      )
    }

    // On desktop, use Tooltip for hover behavior
    return (
      <Tooltip>
        <TooltipTrigger asChild>{iconButton}</TooltipTrigger>
        <TooltipContent side="bottom">{contentElement}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          className="!text-text-muted hover:!text-text-primary"
          size="sm"
          style={{
            padding: 0,
            height: 'auto',
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
          {brief}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{detail}</TooltipContent>
    </Tooltip>
  )
}
