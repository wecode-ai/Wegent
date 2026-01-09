'use client'

import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle } from 'lucide-react'

interface DifferenceIndicatorProps {
  difference?: number
  threshold?: number
  showLabel?: boolean
}

export function DifferenceIndicator({
  difference,
  threshold = 0.2,
  showLabel = true,
}: DifferenceIndicatorProps) {
  const { t } = useTranslation()

  if (difference == null) {
    return <span className="text-sm text-muted-foreground">-</span>
  }

  const isAlert = difference > threshold

  return (
    <div className="flex items-center gap-1">
      {showLabel && (
        <span className="text-xs text-muted-foreground">
          {t('metrics.difference', 'Difference')}:
        </span>
      )}
      <span className={`text-sm font-medium ${isAlert ? 'text-orange-600' : 'text-green-600'}`}>
        {(difference * 100).toFixed(1)}%
      </span>
      {isAlert ? (
        <AlertTriangle className="h-4 w-4 text-orange-500" />
      ) : (
        <CheckCircle className="h-4 w-4 text-green-500" />
      )}
    </div>
  )
}
