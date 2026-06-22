// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Coins, Gauge } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { quotaApis, QuotaData } from '@/apis/quota'
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/use-toast'
import { getRuntimeConfigSync } from '@/lib/runtime-config'
import {
  useChatStatusIndicator,
  type ChatStatusDisplayModel,
} from '@/features/tasks/hooks/useChatStatusIndicator'
import { cn } from '@/lib/utils'

const ACTIVE_TASK_STATUS_PATHS = ['/chat', '/generate', '/devices/chat']

type ChatToolbarStatusProps = {
  className?: string
  compact?: boolean
}

function isTaskStatusRoute(pathname: string | null): boolean {
  if (!pathname) {
    return false
  }

  return ACTIVE_TASK_STATUS_PATHS.some(path => pathname === path || pathname.startsWith(`${path}/`))
}

function ChatStatusSection({
  display,
  isCompacting,
  title,
  compactingLabel,
  contextRemainingLabel,
  contextUsageLabel,
  overTriggerLabel,
}: {
  display: ChatStatusDisplayModel
  isCompacting: boolean
  title: string
  compactingLabel: string
  contextRemainingLabel: string
  contextUsageLabel: string
  overTriggerLabel: string
}) {
  return (
    <section className="space-y-1.5" data-testid="chat-status-section">
      <div className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
        <Gauge className="h-3.5 w-3.5 text-text-muted" />
        <span>{title}</span>
      </div>
      {isCompacting && (
        <div
          className="flex items-center gap-1.5 text-text-muted"
          data-testid="chat-status-compacting"
        >
          <Spinner size="sm" />
          <span>{compactingLabel}</span>
        </div>
      )}
      <div className="text-sm text-text-primary">{contextRemainingLabel}</div>
      <div className="text-text-muted">{contextUsageLabel}</div>
      {display.isOverTrigger && <div className="text-amber-700">{overTriggerLabel}</div>}
    </section>
  )
}

function QuotaSection({
  title,
  brief,
  monthlyDetail,
  permanentDetail,
}: {
  title: string
  brief: string
  monthlyDetail: string
  permanentDetail: string
}) {
  return (
    <section className="space-y-1.5" data-testid="quota-usage-section">
      <div className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
        <Coins className="h-3.5 w-3.5 text-text-muted" />
        <span>{title}</span>
      </div>
      <div className="text-sm text-text-primary">{brief}</div>
      <div className="text-text-muted">{monthlyDetail}</div>
      <div className="text-text-muted">{permanentDetail}</div>
    </section>
  )
}

function useQuotaUsageData(enabled: boolean) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [quota, setQuota] = useState<QuotaData | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const hasShownQuotaErrorRef = useRef(false)

  const handleLoadQuota = React.useCallback(() => {
    if (!enabled) {
      return
    }

    setLoading(true)
    setError(null)
    quotaApis
      .fetchQuota()
      .then(data => {
        setQuota(data)
        hasShownQuotaErrorRef.current = false
      })
      .catch(() => {
        setError(t('common:quota.load_failed'))
        if (!hasShownQuotaErrorRef.current) {
          toast({
            variant: 'destructive',
            title: t('common:quota.load_failed'),
          })
          hasShownQuotaErrorRef.current = true
        }
      })
      .finally(() => {
        setLoading(false)
      })
  }, [enabled, t, toast])

  useEffect(() => {
    if (!enabled) {
      return
    }
    handleLoadQuota()
  }, [enabled, handleLoadQuota])

  useEffect(() => {
    if (!enabled) {
      return
    }

    const timer = setInterval(() => {
      handleLoadQuota()
    }, 20000)

    return () => clearInterval(timer)
  }, [enabled, quota, handleLoadQuota])

  return useMemo(
    () => ({
      quota,
      loading,
      error,
    }),
    [quota, loading, error]
  )
}

export default function ChatToolbarStatus({ className, compact = false }: ChatToolbarStatusProps) {
  const { t } = useTranslation()
  const pathname = usePathname()
  const status = useChatStatusIndicator()
  const enableDisplayQuotas = getRuntimeConfigSync().enableDisplayQuotas
  const supportedRoute = isTaskStatusRoute(pathname)
  const { quota, loading, error } = useQuotaUsageData(enableDisplayQuotas)

  const showStatusSection =
    status.enabled && supportedRoute && !!status.currentTaskId && !!status.display
  const showQuotaSection = enableDisplayQuotas && !!quota
  const quotaHasError = enableDisplayQuotas && !!error && !quota
  const hasVisibleContent = showStatusSection || showQuotaSection || quotaHasError

  if (!enableDisplayQuotas && !showStatusSection) {
    return null
  }

  if (!hasVisibleContent && !showStatusSection) {
    if (loading) {
      if (compact) {
        return null
      }

      return (
        <div className={`flex items-center justify-center mt-1 mb-2 ${className ?? ''}`}>
          <Spinner size="sm" />
        </div>
      )
    }

    return null
  }

  const quotaDetail = quota?.user_quota_detail
  const quotaBrief =
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

  const statusDisplay = status.display
  const contentElement = (
    <div className="space-y-3 text-xs" data-testid="chat-toolbar-status-popover">
      {showQuotaSection && quotaDetail && quotaBrief && (
        <QuotaSection
          title={t('common:quota.title')}
          brief={quotaBrief}
          monthlyDetail={t('common:quota.detail_monthly', {
            monthly_quota: quotaDetail.monthly_quota,
            monthly_usage: quotaDetail.monthly_usage,
            monthly_left: quotaDetail.monthly_quota - quotaDetail.monthly_usage,
          })}
          permanentDetail={t('common:quota.detail_permanent', {
            permanent_quota: quotaDetail.permanent_quota,
            permanent_usage: quotaDetail.permanent_usage,
            permanent_left: quotaDetail.permanent_quota - quotaDetail.permanent_usage,
          })}
        />
      )}

      {showQuotaSection && (showStatusSection || quotaHasError) && (
        <div className="border-t border-border" aria-hidden="true" />
      )}

      {showStatusSection && statusDisplay && (
        <ChatStatusSection
          display={statusDisplay}
          isCompacting={status.isCompacting}
          title={t('common:chat_status.title')}
          compactingLabel={t('common:chat_status.compacting')}
          contextRemainingLabel={t('common:chat_status.context_remaining', {
            percent: statusDisplay.percent,
          })}
          contextUsageLabel={t('common:chat_status.context_usage', {
            used: statusDisplay.usedTokens,
            total: statusDisplay.totalTokens,
          })}
          overTriggerLabel={t('common:chat_status.over_trigger')}
        />
      )}

      {showStatusSection && quotaHasError && (
        <div className="border-t border-border" aria-hidden="true" />
      )}

      {quotaHasError && (
        <section className="space-y-1.5" data-testid="quota-error-section">
          <div className="text-sm font-medium text-text-primary">{t('common:quota.title')}</div>
          <div className="text-text-muted">{t('common:quota.load_failed')}</div>
        </section>
      )}
    </div>
  )

  const triggerIconClassName = 'h-4 w-4 text-text-muted hover:text-text-primary'

  if (compact) {
    return (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <Popover>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn('relative h-6 w-6 flex-shrink-0', className ?? '')}
                  data-testid="chat-toolbar-status-trigger"
                  style={{ padding: 0 }}
                >
                  <Coins className={triggerIconClassName} />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <PopoverContent side="bottom" align="end" className="w-64 p-3">
              {contentElement}
            </PopoverContent>
          </Popover>
          <TooltipContent side="top">{t('common:chat_status.tooltip')}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <Popover>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                className={cn(
                  'h-auto gap-1.5 px-0 !text-text-muted hover:!text-text-primary',
                  className ?? ''
                )}
                data-testid="chat-toolbar-status-trigger"
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
                <Coins className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <PopoverContent side="bottom" align="end" className="w-64 p-3">
            {contentElement}
          </PopoverContent>
        </Popover>
        <TooltipContent side="top">{t('common:chat_status.tooltip')}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
