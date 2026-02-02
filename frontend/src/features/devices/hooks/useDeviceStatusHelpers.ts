// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

/**
 * Hook providing device status helper functions
 * Shared between Desktop and Mobile device page implementations
 */
export function useDeviceStatusHelpers() {
  const { t } = useTranslation('devices')

  const getStatusColor = useCallback((status: string) => {
    switch (status) {
      case 'online':
        return 'bg-green-500'
      case 'busy':
        return 'bg-yellow-500'
      default:
        return 'bg-gray-400'
    }
  }, [])

  const getStatusText = useCallback(
    (status: string) => {
      switch (status) {
        case 'online':
          return t('status_online')
        case 'busy':
          return t('status_busy')
        default:
          return t('status_offline')
      }
    },
    [t]
  )

  return { getStatusColor, getStatusText }
}
