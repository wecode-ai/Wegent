// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * DeviceSelectorTab component for selecting execution mode in the chat input area.
 *
 * Features:
 * - Tab switching between "Cloud" (system managed) and "Device" (specific device)
 * - Device tab shows dropdown with both local and cloud devices
 * - Only shows for new chats (when hasMessages is false)
 * - Shows read-only state for existing chats
 * - No page navigation - just switches device selection state
 */

import { useMemo, useState, useEffect } from 'react'
import { useDevices } from '@/contexts/DeviceContext'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { Monitor, Cloud, ChevronDown, Star, AlertCircle, Server } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

type DeviceTabType = 'cloud' | 'device'

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
  const { devices, selectedDeviceId, setSelectedDeviceId, setDefaultDevice, isLoading } =
    useDevices()

  // Determine active tab based on selection
  const [activeTab, setActiveTab] = useState<DeviceTabType>(selectedDeviceId ? 'device' : 'cloud')

  // Sync with external selection
  useEffect(() => {
    setActiveTab(selectedDeviceId ? 'device' : 'cloud')
  }, [selectedDeviceId])

  // Get all devices (local + cloud) excluding offline ones, sorted by status
  const allDevices = useMemo(() => {
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

  // Separate local and cloud devices
  const localDevices = useMemo(() => {
    return allDevices.filter(d => d.device_type !== 'cloud')
  }, [allDevices])

  const cloudDevices = useMemo(() => {
    return allDevices.filter(d => d.device_type === 'cloud')
  }, [allDevices])

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

  const isDeviceAtCapacity = (slotUsed: number, slotMax: number) => {
    // `0` means unlimited capacity for local devices.
    return slotMax > 0 && slotUsed >= slotMax
  }

  const formatSlotUsage = (slotUsed: number, slotMax: number) => {
    return slotMax > 0 ? `${slotUsed}/${slotMax}` : `${slotUsed}/∞`
  }

  // Handle tab switch - only updates device selection state, no page navigation
  const handleTabSwitch = (tab: DeviceTabType) => {
    if (disabled || hasMessages || isLoading) return
    setActiveTab(tab)
    if (tab === 'cloud') {
      setSelectedDeviceId(null)
    } else if (allDevices.length > 0) {
      // Select the first available device (prefer default)
      const defaultDevice = allDevices.find(d => d.is_default)
      setSelectedDeviceId(defaultDevice?.device_id || allDevices[0].device_id)
    }
  }

  // Handle device selection - only updates device selection state, no page navigation
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
                  <span
                    className={cn(
                      'w-1.5 h-1.5 rounded-full',
                      getStatusColor(selectedDevice.status)
                    )}
                  />
                </>
              ) : (
                <>
                  <Cloud className="w-3.5 h-3.5" />
                  <span>{t('cloud_tab')}</span>
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
          'flex items-center overflow-hidden',
          disabled && 'opacity-50 cursor-not-allowed',
          className
        )}
      >
        {/* Cloud Tab - System managed execution */}
        <button
          type="button"
          onClick={() => handleTabSwitch('cloud')}
          disabled={disabled || isLoading}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border border-border',
            activeTab === 'cloud'
              ? 'bg-base text-text-primary border-border border-b-base relative z-10'
              : 'bg-surface text-text-secondary hover:text-text-primary hover:bg-hover border-transparent'
          )}
        >
          <Cloud className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">{t('cloud_tab')}</span>
          <span className="sm:hidden">{t('cloud_tab').slice(0, 2)}</span>
        </button>

        {/* Device Tab - Select specific device (local or cloud) */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={disabled || isLoading}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border border-border -ml-px',
                activeTab === 'device'
                  ? 'bg-base text-text-primary border-border border-b-base relative z-10'
                  : 'bg-surface text-text-secondary hover:text-text-primary hover:bg-hover border-transparent',
                (disabled || isLoading) && 'opacity-50 cursor-not-allowed'
              )}
            >
              <Monitor className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">
                {activeTab === 'device' && selectedDevice ? selectedDevice.name : t('device_tab')}
              </span>
              <span className="sm:hidden">
                {activeTab === 'device' && selectedDevice
                  ? selectedDevice.name.slice(0, 4)
                  : t('device_tab').slice(0, 2)}
              </span>
              {activeTab === 'device' && selectedDevice && (
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
            {/* Local Devices Section */}
            {localDevices.length > 0 && (
              <>
                <div className="px-3 py-1.5 text-xs font-medium text-text-muted bg-surface">
                  {t('local_devices_section')}
                </div>
                {localDevices.map(device => {
                  const isFull = isDeviceAtCapacity(device.slot_used, device.slot_max)
                  const isBusy = device.status === 'busy'
                  const isDisabled = isFull
                  const isSelected = selectedDeviceId === device.device_id

                  return (
                    <DropdownMenuItem
                      key={device.device_id}
                      onSelect={() => {
                        if (!isDisabled) {
                          handleDeviceSelect(device.device_id)
                          setActiveTab('device')
                        }
                      }}
                      disabled={isDisabled}
                      className={cn(
                        'group flex items-center gap-2 cursor-pointer',
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
                        {formatSlotUsage(device.slot_used, device.slot_max)}
                      </span>

                      {/* Default indicator */}
                      {device.is_default ? (
                        <Star className="w-3 h-3 text-yellow-500 fill-yellow-500 flex-shrink-0" />
                      ) : (
                        <button
                          type="button"
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
                })}
              </>
            )}

            {/* Cloud Devices Section */}
            {cloudDevices.length > 0 && (
              <>
                {localDevices.length > 0 && <DropdownMenuSeparator />}
                <div className="px-3 py-1.5 text-xs font-medium text-text-muted bg-surface">
                  {t('cloud_devices_section')}
                </div>
                {cloudDevices.map(device => {
                  const isFull = isDeviceAtCapacity(device.slot_used, device.slot_max)
                  const isBusy = device.status === 'busy'
                  const isDisabled = isFull
                  const isSelected = selectedDeviceId === device.device_id

                  return (
                    <DropdownMenuItem
                      key={device.device_id}
                      onSelect={() => {
                        if (!isDisabled) {
                          handleDeviceSelect(device.device_id)
                          setActiveTab('device')
                        }
                      }}
                      disabled={isDisabled}
                      className={cn(
                        'group flex items-center gap-2 cursor-pointer',
                        isSelected && 'bg-accent',
                        isDisabled && 'opacity-50 cursor-not-allowed'
                      )}
                    >
                      <Server className="w-4 h-4 flex-shrink-0" />
                      <span className="flex-1 truncate text-sm">{device.name}</span>

                      {/* Slot usage */}
                      <span
                        className={cn(
                          'text-xs flex-shrink-0',
                          isFull ? 'text-red-500' : 'text-text-muted'
                        )}
                      >
                        {formatSlotUsage(device.slot_used, device.slot_max)}
                      </span>

                      {/* Default indicator */}
                      {device.is_default ? (
                        <Star className="w-3 h-3 text-yellow-500 fill-yellow-500 flex-shrink-0" />
                      ) : (
                        <button
                          type="button"
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
                })}
              </>
            )}

            {/* No devices message */}
            {allDevices.length === 0 && (
              <div className="px-3 py-2 text-sm text-text-muted text-center">
                {t('no_devices_available')}
              </div>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Warning indicator for unavailable device */}
        {activeTab === 'device' && !isSelectedDeviceAvailable && (
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
