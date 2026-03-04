// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Device setup guide with device type selection.
 * Allows users to choose between local and cloud devices, then shows appropriate setup instructions.
 */

'use client'

import { useState } from 'react'
import { Monitor, Cloud, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { LocalExecutorGuide } from './LocalExecutorGuide'
import { CloudDeviceCreateSection } from '@wecode/components/devices/CloudDeviceCreateSection'

export interface DeviceSetupGuideProps {
  backendUrl: string
  authToken: string
  guideUrl?: string
  onDeviceCreated: () => void
  onClose?: () => void
  showCloseButton?: boolean
  cloudDeviceCount?: number
}

type DeviceType = 'local' | 'cloud'

/**
 * Device setup guide with tabbed interface for device type selection.
 *
 * Features:
 * - Tab selection between Local and Cloud devices
 * - Local device shows full installation guide
 * - Cloud device shows creation section with Mail Skill configuration
 * - Optional close button to return to device list
 */
export function DeviceSetupGuide({ backendUrl, authToken, guideUrl, onDeviceCreated, onClose, showCloseButton, cloudDeviceCount = 0 }: DeviceSetupGuideProps) {
  const { t } = useTranslation('devices')
  const [deviceType, setDeviceType] = useState<DeviceType>('local')

  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      {/* Device Type Tabs */}
      <div className="flex items-center justify-between gap-2 px-6 pt-4 border-b border-border">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setDeviceType('local')}
            className={cn(
              'flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors relative',
              deviceType === 'local'
                ? 'text-primary'
                : 'text-text-muted hover:text-text-secondary'
            )}
          >
            <Monitor className="w-4 h-4" />
            {t('local_device')}
            {deviceType === 'local' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
            )}
          </button>

          <button
            type="button"
            onClick={() => setDeviceType('cloud')}
            className={cn(
              'flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors relative',
              deviceType === 'cloud'
                ? 'text-primary'
                : 'text-text-muted hover:text-text-secondary'
            )}
          >
            <Cloud className="w-4 h-4" />
            {t('cloud_device')}
            {deviceType === 'cloud' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
            )}
          </button>
        </div>

        {/* Close button */}
        {showCloseButton && onClose && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-8 w-8 p-0 hover:bg-border"
          >
            <X className="w-4 h-4" />
          </Button>
        )}
      </div>

      {/* Content Area */}
      <div className="p-6">
        {deviceType === 'local' ? (
          <LocalExecutorGuide backendUrl={backendUrl} authToken={authToken} guideUrl={guideUrl} />
        ) : (
          <CloudDeviceCreateSection onDeviceCreated={onDeviceCreated} currentDeviceCount={cloudDeviceCount} />
        )}
      </div>
    </div>
  )
}
