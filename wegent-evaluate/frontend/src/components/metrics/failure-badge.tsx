'use client'

import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'

interface FailureBadgeProps {
  failureReason?: string | null
  size?: 'sm' | 'md' | 'lg'
}

export function FailureBadge({ failureReason, size = 'md' }: FailureBadgeProps) {
  const { t } = useTranslation()

  const sizeClasses = {
    sm: 'text-xs px-1.5 py-0.5',
    md: 'text-sm px-2 py-1',
    lg: 'text-base px-3 py-1.5',
  }

  const iconSizes = {
    sm: 'h-3 w-3',
    md: 'h-4 w-4',
    lg: 'h-5 w-5',
  }

  return (
    <span
      className={`inline-flex items-center gap-1 rounded bg-red-100 text-red-700 font-semibold ${sizeClasses[size]}`}
      title={failureReason || undefined}
    >
      <AlertTriangle className={iconSizes[size]} />
      {t('metrics.failed', 'FAILED')}
    </span>
  )
}
