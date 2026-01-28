// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

interface TruncatedIndicatorProps {
  originalLength: number
  unit?: 'characters' | 'lines'
}

/**
 * Indicator showing content was truncated
 */
export const TruncatedIndicator = memo(function TruncatedIndicator({
  originalLength,
  unit = 'characters',
}: TruncatedIndicatorProps) {
  const { t } = useTranslation('chat')

  const unitLabel =
    unit === 'lines'
      ? t('thinking.units.lines') || 'lines'
      : t('thinking.units.characters') || 'characters'

  return (
    <div className="mt-2 text-xs text-text-tertiary italic">
      {t('thinking.truncated') || 'Truncated'} ({originalLength.toLocaleString()} {unitLabel})
    </div>
  )
})
