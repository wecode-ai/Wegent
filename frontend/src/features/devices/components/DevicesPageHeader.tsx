// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Devices page header component.
 * Displays page title, beta badge, and action buttons (Add Device, Refresh).
 */

'use client'

import { Monitor, RefreshCw, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'

export interface DevicesPageHeaderProps {
  isLoading: boolean
  hasDevices: boolean
  onRefresh: () => void
  onAddDevice: () => void
}

/**
 * Devices page header with title and action buttons.
 *
 * Features:
 * - Title with Monitor icon and beta badge
 * - Add Device button (only shown when devices exist)
 * - Refresh button with loading spinner
 */
export function DevicesPageHeader({
  isLoading,
  hasDevices,
  onRefresh,
  onAddDevice,
}: DevicesPageHeaderProps) {
  const { t } = useTranslation('devices')

  return (
    <div className="flex items-center justify-between mb-6">
      <div className="flex items-center gap-3">
        <Monitor className="w-6 h-6 text-primary" />
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        <span className="px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-700 rounded-full">
          {t('beta')}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {/* Add Device button - only show when devices exist */}
        {hasDevices && (
          <Button
            variant="outline"
            size="sm"
            onClick={onAddDevice}
            className="flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            {t('add_device')}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={isLoading}
          className="flex items-center gap-2"
        >
          <RefreshCw className={cn('w-4 h-4', isLoading && 'animate-spin')} />
          {t('refresh')}
        </Button>
      </div>
    </div>
  )
}
