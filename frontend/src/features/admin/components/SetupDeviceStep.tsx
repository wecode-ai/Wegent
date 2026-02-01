// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ComputerDesktopIcon, CheckCircleIcon, ArrowPathIcon } from '@heroicons/react/24/outline'
import { Loader2, Copy, Check, ExternalLink, Monitor, Star } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { useDevices } from '@/contexts/DeviceContext'
import { SlotIndicator } from '@/features/devices/components/SlotIndicator'
import { cn } from '@/lib/utils'

interface SetupDeviceStepProps {
  /** Called when a device is successfully connected */
  onDeviceConnected?: () => void
}

const SetupDeviceStep: React.FC<SetupDeviceStepProps> = ({ onDeviceConnected }) => {
  const { t } = useTranslation('admin')
  const { t: tDevices } = useTranslation('devices')
  const { devices, refreshDevices, isLoading } = useDevices()
  const [copied, setCopied] = useState(false)

  // Get environment variables
  const installCommand = process.env.NEXT_PUBLIC_DEVICE_INSTALL_COMMAND || ''
  const guideUrl = process.env.NEXT_PUBLIC_DEVICE_GUIDE_URL || ''

  // Filter online devices
  const onlineDevices = useMemo(
    () => devices.filter(d => d.status === 'online' || d.status === 'busy'),
    [devices]
  )

  // Notify parent when a device is connected
  useEffect(() => {
    if (onlineDevices.length > 0 && onDeviceConnected) {
      onDeviceConnected()
    }
  }, [onlineDevices.length, onDeviceConnected])

  // Copy command to clipboard
  const handleCopy = useCallback(async () => {
    if (!installCommand) return
    try {
      await navigator.clipboard.writeText(installCommand)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy command:', err)
    }
  }, [installCommand])

  // Handle refresh
  const handleRefresh = useCallback(async () => {
    await refreshDevices()
  }, [refreshDevices])

  // Get status color
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'online':
        return 'bg-green-500'
      case 'busy':
        return 'bg-yellow-500'
      default:
        return 'bg-gray-400'
    }
  }

  // Get status text
  const getStatusText = (status: string) => {
    switch (status) {
      case 'online':
        return tDevices('status_online')
      case 'busy':
        return tDevices('status_busy')
      default:
        return tDevices('status_offline')
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="text-center">
        <h3 className="text-lg font-semibold text-text-primary">
          {t('setup_wizard.device_step.title')}
        </h3>
        <p className="text-sm text-text-muted mt-1">{t('setup_wizard.device_step.description')}</p>
      </div>

      {/* Install Command Section */}
      {installCommand && (
        <div className="space-y-2">
          <p className="text-sm text-text-secondary">
            {t('setup_wizard.device_step.install_hint')}
          </p>
          <div className="relative">
            <div className="bg-[#1e1e1e] text-[#d4d4d4] rounded-lg p-4 font-mono text-sm overflow-x-auto">
              <code className="whitespace-pre-wrap break-all">{installCommand}</code>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="absolute top-2 right-2 h-8 px-3 bg-[#2d2d2d] hover:bg-[#3d3d3d] text-[#d4d4d4]"
              onClick={handleCopy}
            >
              {copied ? (
                <>
                  <Check className="w-4 h-4 mr-1.5" />
                  {t('setup_wizard.device_step.copied')}
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4 mr-1.5" />
                  {t('setup_wizard.device_step.copy_command')}
                </>
              )}
            </Button>
          </div>

          {/* Guide Link */}
          {guideUrl && (
            <div className="flex justify-center mt-2">
              <a
                href={guideUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center text-sm text-primary hover:underline"
              >
                <ExternalLink className="w-4 h-4 mr-1" />
                {t('setup_wizard.device_step.view_guide')}
              </a>
            </div>
          )}
        </div>
      )}

      {/* Device Status Section */}
      <div className="bg-base border border-border rounded-md p-3 min-h-[150px]">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-text-secondary">
            {t('setup_wizard.device_step.device_name')}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            disabled={isLoading}
            className="h-7 px-2"
          >
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <>
                <ArrowPathIcon className="w-4 h-4 mr-1" />
                {t('setup_wizard.device_step.refresh')}
              </>
            )}
          </Button>
        </div>

        {isLoading && devices.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
          </div>
        ) : onlineDevices.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <ComputerDesktopIcon className="w-12 h-12 text-text-muted mb-3" />
            <div className="flex items-center gap-2 text-text-muted">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>{t('setup_wizard.device_step.detecting')}</span>
            </div>
            <p className="text-xs text-text-muted mt-2">
              {t('setup_wizard.device_step.no_device_hint')}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {onlineDevices.map(device => (
              <Card
                key={device.device_id}
                className={cn(
                  'p-3 bg-surface',
                  device.is_default ? 'border-primary' : 'border-border'
                )}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 bg-primary/10 rounded-lg flex items-center justify-center">
                      <Monitor className="w-4 h-4 text-primary" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-text-primary truncate">
                          {device.name || device.device_id}
                        </span>
                        {device.is_default && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-primary/10 text-primary rounded-full">
                            <Star className="w-3 h-3 fill-current" />
                            {tDevices('default_device')}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-text-muted mt-0.5">
                        ID: {device.device_id.slice(0, 8)}...
                      </div>
                      {/* Slot indicator - shows slot usage for online devices */}
                      <div className="mt-1.5">
                        <SlotIndicator
                          used={device.slot_used}
                          max={device.slot_max}
                          runningTasks={device.running_tasks}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={cn('w-2 h-2 rounded-full', getStatusColor(device.status))} />
                    <span className="text-sm text-text-secondary">
                      {getStatusText(device.status)}
                    </span>
                    <CheckCircleIcon className="w-5 h-5 text-green-500 ml-2" />
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default SetupDeviceStep
