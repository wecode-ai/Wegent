// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * DeviceSelectorTab component for selecting local device or cloud executor
 * in the chat input area using a tab-based design.
 *
 * Features:
 * - Tab switching between "Cloud Executor" and "Local Device"
 * - Shows online devices in a dropdown when "Local Device" tab is selected
 * - Only shows for new chats (when hasMessages is false)
 * - Shows read-only state for existing chats
 */

import { useMemo, useState, useEffect } from 'react'
import { useDevices } from '@/contexts/DeviceContext'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { Monitor, Cloud, ChevronDown, Star, AlertCircle } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

type DeviceTabType = 'cloud' | 'local'

interface DeviceSelectorTabProps {
  /** Additional className */
  className?: string
  /** Disabled state */
  disabled?: boolean
  /** Whether the chat has messages (read-only mode) */
  hasMessages?: boolean
  /** The device ID used when the task was created (for read-only display) */
  taskDeviceId?: string | null
}

export function DeviceSelectorTab({
  className,
  disabled,
  hasMessages = false,
  taskDeviceId,
}: DeviceSelectorTabProps) {
  const { t } = useTranslation('devices')
  const {
    devices,
    selectedDeviceId,
    setSelectedDeviceId,
    setDefaultDevice,
    isLoading,
  } = useDevices()

  // Determine active tab based on selection
  const [activeTab, setActiveTab] = useState<DeviceTabType>(
    selectedDeviceId ? 'local' : 'cloud'
  )

  // Sync with external selection
  useEffect(() => {
    if (!hasMessages) {
      setActiveTab(selectedDeviceId ? 'local' : 'cloud')
    }
  }, [selectedDeviceId, hasMessages])

  // Get online devices only (sorted: online > busy)
  const onlineDevices = useMemo(() => {
    return devices
      .filter(d => d.status !== 'offline')
      .sort((a, b) => {
        // Sort by status: online first, then busy
        if (a.status === 'online' && b.status !== 'online') return -1
        if (a.status !== 'online' && b.status === 'online') return 1
        // Then by default status
        if (a.is_default && !b.is_default) return -1
        if (!a.is_default && b.is_default) return 1
        return 0
      })
  }, [devices])

  // Get selected device info
  const selectedDevice = useMemo(() => {
    if (hasMessages && taskDeviceId) {
      return devices.find(d => d.device_id === taskDeviceId)
    }
    return selectedDeviceId ? devices.find(d => d.device_id === selectedDeviceId) : null
  }, [devices, selectedDeviceId, hasMessages, taskDeviceId])

  // Check if selected device is available
  const isSelectedDeviceAvailable = useMemo(() => {
    if (activeTab === 'cloud') return true
    if (!selectedDevice) return false
    return selectedDevice.status !== 'offline'
  }, [activeTab, selectedDevice])

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

  // Handle tab switch
  const handleTabSwitch = (tab: DeviceTabType) => {
    if (disabled || hasMessages || isLoading) return
    setActiveTab(tab)
    if (tab === 'cloud') {
      setSelectedDeviceId(null)
    } else if (onlineDevices.length > 0) {
      // Select the first available device (prefer default)
      const defaultDevice = onlineDevices.find(d => d.is_default)
      setSelectedDeviceId(defaultDevice?.device_id || onlineDevices[0].device_id)
    }
  }

  // Handle device selection
  const handleDeviceSelect = (deviceId: string) => {
    setSelectedDeviceId(deviceId)
  }

  // Handle setting default device
  const handleSetDefault = async (e: React.MouseEvent, deviceId: string) => {
    e.stopPropagation()
    try {
      await setDefaultDevice(deviceId)
    } catch {
      // Error is logged in context
    }
  }

  // If no local devices and not in read-only mode, don't show the selector
  if (devices.length === 0 && !hasMessages && !isLoading) {
    return null
  }

  // Read-only mode for existing chats
  if (hasMessages) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                'flex items-center gap-1.5 px-2 py-1.5 rounded-md',
                'bg-surface border border-border',
                'text-xs text-text-secondary',
                className
              )}
            >
              {taskDeviceId && selectedDevice ? (
                <>
                  <Monitor className="w-3.5 h-3.5" />
                  <span className="truncate max-w-[100px]">{selectedDevice.name}</span>
                  <span className={cn('w-1.5 h-1.5 rounded-full', getStatusColor(selectedDevice.status))} />
                </>
              ) : (
                <>
                  <Cloud className="w-3.5 h-3.5" />
                  <span>{t('cloud_executor')}</span>
                </>
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{t('select_device_hint')}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return (
    <TooltipProvider>
      <div
        className={cn(
          'flex items-center rounded-lg border border-border bg-surface overflow-hidden',
          disabled && 'opacity-50 cursor-not-allowed',
          className
        )}
      >
        {/* Cloud Executor Tab */}
        <button
          type="button"
          onClick={() => handleTabSwitch('cloud')}
          disabled={disabled || isLoading}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-colors',
            activeTab === 'cloud'
              ? 'bg-primary text-white'
              : 'text-text-secondary hover:text-text-primary hover:bg-hover'
          )}
        >
          <Cloud className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">{t('cloud_executor')}</span>
          <span className="sm:hidden">{t('cloud_executor').slice(0, 2)}</span>
        </button>

        {/* Local Device Tab */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={disabled || isLoading || onlineDevices.length === 0}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-colors border-l border-border',
                activeTab === 'local'
                  ? 'bg-primary text-white'
                  : 'text-text-secondary hover:text-text-primary hover:bg-hover',
                (disabled || isLoading || onlineDevices.length === 0) && 'opacity-50 cursor-not-allowed'
              )}
            >
              <Monitor className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">
                {activeTab === 'local' && selectedDevice
                  ? selectedDevice.name
                  : t('local_devices_section')}
              </span>
              <span className="sm:hidden">
                {activeTab === 'local' && selectedDevice
                  ? selectedDevice.name.slice(0, 4)
                  : t('local_devices_section').slice(0, 2)}
              </span>
              {activeTab === 'local' && selectedDevice && (
                <span
                  className={cn(
                    'w-1.5 h-1.5 rounded-full ml-0.5',
                    getStatusColor(selectedDevice.status)
                  )}
                />
              )}
              <ChevronDown className="w-3 h-3 opacity-70" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {/* Online devices */}
            {onlineDevices.length > 0 ? (
              onlineDevices.map(device => {
                const isFull = device.slot_used >= device.slot_max
                const isBusy = device.status === 'busy'
                const isDisabled = isFull
                const isSelected = selectedDeviceId === device.device_id

                return (
                  <DropdownMenuItem
                    key={device.device_id}
                    onClick={() => !isDisabled && handleDeviceSelect(device.device_id)}
                    disabled={isDisabled}
                    className={cn(
                      'flex items-center gap-2 cursor-pointer',
                      isSelected && 'bg-accent',
                      isDisabled && 'opacity-50 cursor-not-allowed'
                    )}
                  >
                    <Monitor className="w-4 h-4 flex-shrink-0" />
                    <span className="flex-1 truncate text-sm">{device.name}</span>

                    {/* Slot usage */}
                    <span
                      className={cn(
                        'text-xs flex-shrink-0',
                        isFull ? 'text-red-500' : 'text-text-muted'
                      )}
                    >
                      {device.slot_used}/{device.slot_max}
                    </span>

                    {/* Default indicator */}
                    {device.is_default ? (
                      <Star className="w-3 h-3 text-yellow-500 fill-yellow-500 flex-shrink-0" />
                    ) : (
                      // Set default button (appears on hover)
                      <button
                        onClick={e => handleSetDefault(e, device.device_id)}
                        className="opacity-0 group-hover:opacity-100 hover:opacity-100 focus:opacity-100 p-1"
                        title={t('set_as_default')}
                      >
                        <Star className="w-3 h-3 text-text-muted hover:text-yellow-500" />
                      </button>
                    )}

                    {/* Status indicator */}
                    <span
                      className={cn(
                        'w-2 h-2 rounded-full flex-shrink-0',
                        getStatusColor(device.status)
                      )}
                    />

                    {/* Warning for busy device */}
                    {isBusy && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <AlertCircle className="w-3.5 h-3.5 text-yellow-500 flex-shrink-0" />
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          <p>{t('device_busy_hint')}</p>
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </DropdownMenuItem>
                )
              })
            ) : (
              <div className="px-3 py-2 text-sm text-text-muted text-center">
                {t('no_local_devices')}
              </div>
            )}

            {/* Clear default option */}
            {selectedDeviceId && devices.some(d => d.is_default) && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => handleSetDefault({ stopPropagation: () => {} } as React.MouseEvent, '')}
                  className="text-xs text-text-muted"
                >
                  {t('clear_default') || '清除默认设备'}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Warning indicator for unavailable device */}
        {activeTab === 'local' && !isSelectedDeviceAvailable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="px-1.5">
                <AlertCircle className="w-4 h-4 text-red-500" />
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>{t('device_offline_cannot_send')}</p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  )
}

export default DeviceSelectorTab
