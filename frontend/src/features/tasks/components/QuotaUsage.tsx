import React, { useEffect, useState } from 'react'
import { Tooltip, Spin, Button } from 'antd'

import { copilotApis, QuotaData } from '@/apis/copilot'
import { App } from 'antd'
import { useTranslation } from '@/hooks/useTranslation'

type QuotaUsageProps = {
  className?: string
}

export default function QuotaUsage({ className }: QuotaUsageProps) {
  const deployMode = process.env.NEXT_PUBLIC_FRONTEND_DEPLOY_MODE
  if (deployMode !== 'weibo') {
    return null
  }

  const { t } = useTranslation('common')
  const { message } = App.useApp()
  const [quota, setQuota] = useState<QuotaData | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  const handleLoadQuota = () => {
    setLoading(true)
    setError(null)
    copilotApis.fetchQuota()
      .then((data) => {
        if (data) {
          setQuota(data)
          setError(null)
        } else {
          setError(t('quota.load_failed'))
          message.error(t('quota.load_failed'))
        }
      })
      .catch(() => {
        setError(t('quota.load_failed'))
        message.error(t('quota.load_failed'))
      })
      .finally(() => {
        setLoading(false)
      })
  }

  useEffect(() => {
    handleLoadQuota()
    const timer = setInterval(() => {
      handleLoadQuota()
    }, 5000)
    return () => clearInterval(timer)
  }, [])

  if (loading && !quota) {
    return (
      <div className={`flex items-center justify-center mt-1 mb-2 ${className ?? ''}`}>
        <Spin size="small" />
      </div>
    )
  }

  if (error || !quota) {
    return (
      <div className={`text-xs text-text-muted mt-1 mb-2 ${className ?? ''}`}>{error || t('quota.load_failed')}</div>
    )
  }

  const {
    monthly_quota,
    monthly_usage,
    permanent_quota,
    permanent_usage,
  } = quota.user_quota_detail

  const brief = t('quota.brief', {
    monthly_usage,
    monthly_quota: monthly_quota.toLocaleString(),
    permanent_quota: permanent_quota.toLocaleString(),
  })

  const detail = (
    <div>
      <div>
        {t('quota.detail_monthly', {
          monthly_quota,
          monthly_usage,
          monthly_left: monthly_quota - monthly_usage,
        })}
      </div>
      <div>
        {t('quota.detail_permanent', {
          permanent_quota,
          permanent_usage,
          permanent_left: permanent_quota - permanent_usage,
        })}
      </div>
    </div>
  )

  return (
    <Tooltip title={detail} placement="bottom">
      <Button
        type="text"
        className="!text-text-muted hover:!text-text-primary"
        size="small"
        style={{
          padding: 0,
          height: 'auto',
          lineHeight: 'normal',
          color: 'rgb(var(--color-text-muted))',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'rgb(var(--color-text-primary))';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'rgb(var(--color-text-muted))';
        }}
      >
        {brief}
      </Button>
    </Tooltip>
  )
}