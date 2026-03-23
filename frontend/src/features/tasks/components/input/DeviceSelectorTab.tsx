// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * DeviceSelectorTab component for selecting execution target in the chat input area.
 *
 * Features:
 * - Unified selector for local devices, cloud devices, and cloud mode
 * - Automatic default selection for new chats
 * - Read-only state for existing chats
 * - No page navigation - just switches device selection state
 */

import { useMemo, useRef, useEffect } from 'react'
import type { MouseEvent } from 'react'
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
import {
  formatSlotUsage,
  getPreferredExecutionDevice,
  getSelectableDevices,
  getStatusColor,
  isDeviceAtCapacity,
} from '@/features/devices/utils/execution-target'

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
  const autoSelectionInitializedRef = useRef(false)

  const selectableDevices = useMemo(() => getSelectableDevices(devices), [devices])
  const preferredDevice = useMemo(() => getPreferredExecutionDevice(devices), [devices])

  const localDevices = useMemo(() => {
    return selectableDevices.filter(device => device.device_type !== 'cloud')
  }, [selectableDevices])

  const cloudDevices = useMemo(() => {
    return selectableDevices.filter(device => device.device_type === 'cloud')
  }, [selectableDevices])

  const selectedDevice = useMemo(() => {
    if (hasMessages) {
      if (!taskDeviceId) {
        return null
      }

      return devices.find(device => device.device_id === taskDeviceId) ?? null
    }

    return selectedDeviceId
      ? (devices.find(device => device.device_id === selectedDeviceId) ?? null)
      : null
  }, [devices, selectedDeviceId, hasMessages, taskDeviceId])

  useEffect(() => {
    if (hasMessages || isLoading || autoSelectionInitializedRef.current) {
      return
    }

    if (selectedDeviceId) {
      autoSelectionInitializedRef.current = true
      return
    }

    autoSelectionInitializedRef.current = true
    setSelectedDeviceId(preferredDevice?.device_id || null)
  }, [hasMessages, isLoading, preferredDevice, selectedDeviceId, setSelectedDeviceId])

  const isSelectedDeviceAvailable = useMemo(() => {
    if (!selectedDevice) return true
    return selectedDevice.status !== 'offline'
  }, [selectedDevice])

  const handleDeviceSelect = (deviceId: string) => {
    if (disabled || hasMessages || isLoading) return
    autoSelectionInitializedRef.current = true
    setSelectedDeviceId(deviceId)
  }

  const handleCloudModeSelect = () => {
    if (disabled || hasMessages || isLoading) return
    autoSelectionInitializedRef.current = true
    setSelectedDeviceId(null)
  }

  const handleSetDefault = async (e: MouseEvent<HTMLButtonElement>, deviceId: string) => {
    e.stopPropagation()
    try {
      await setDefaultDevice(deviceId)
    } catch {
      // Error is logged in context
    }
  }

  const renderSelectedTarget = () => {
    if (taskDeviceId && hasMessages && selectedDevice) {
      return (
        <>
          {selectedDevice.device_type === 'cloud' ? (
            <Server className="w-3.5 h-3.5" />
          ) : (
            <Monitor className="w-3.5 h-3.5" />
          )}
          <span className="truncate max-w-[100px]">{selectedDevice.name}</span>
          <span className={cn('w-1.5 h-1.5 rounded-full', getStatusColor(selectedDevice.status))} />
        </>
      )
    }

    if (selectedDevice) {
      return (
        <>
          {selectedDevice.device_type === 'cloud' ? (
            <Server className="w-3.5 h-3.5 text-primary" />
          ) : (
            <Monitor className="w-3.5 h-3.5 text-primary" />
          )}
          <span className="max-w-[140px] truncate">{selectedDevice.name}</span>
          <span className={cn('w-1.5 h-1.5 rounded-full', getStatusColor(selectedDevice.status))} />
        </>
      )
    }

    return (
      <>
        <Cloud className="w-3.5 h-3.5 text-primary" />
        <span>{t('cloud_mode')}</span>
      </>
    )
  }

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
              {renderSelectedTarget()}
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={disabled || isLoading}
              data-testid="execution-target-trigger"
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-all duration-200 border rounded-t-md',
                'bg-base text-primary border-border border-b-base relative z-10 shadow-sm',
                (disabled || isLoading) && 'opacity-50 cursor-not-allowed'
              )}
            >
              {renderSelectedTarget()}
              <ChevronDown className="w-3 h-3 opacity-70" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            {localDevices.length > 0 && (
              <>
                <div className="px-3 py-1.5 text-xs font-medium text-text-muted bg-surface">
                  {t('local_devices_section')}
                </div>
                {localDevices.map(device => {
                  const isFull = isDeviceAtCapacity(device.slot_used, device.slot_max)
                  const isBusy = device.status === 'busy'
                  const isSelected = selectedDeviceId === device.device_id

                  return (
                    <DropdownMenuItem
                      key={device.device_id}
                      data-testid={`execution-target-device-${device.device_id}`}
                      onSelect={() => {
                        if (!isFull) {
                          handleDeviceSelect(device.device_id)
                        }
                      }}
                      disabled={isFull}
                      className={cn(
                        'group flex items-center gap-2 cursor-pointer',
                        isSelected && 'bg-accent',
                        isFull && 'opacity-50 cursor-not-allowed'
                      )}
                    >
                      <Monitor className="w-4 h-4 flex-shrink-0" />
                      <span className="flex-1 truncate text-sm">{device.name}</span>
                      <span
                        className={cn(
                          'text-xs flex-shrink-0',
                          isFull ? 'text-red-500' : 'text-text-muted'
                        )}
                      >
                        {formatSlotUsage(device.slot_used, device.slot_max)}
                      </span>
                      {device.is_default ? (
                        <Star className="w-3 h-3 text-yellow-500 fill-yellow-500 flex-shrink-0" />
                      ) : (
                        <button
                          type="button"
                          onClick={e => void handleSetDefault(e, device.device_id)}
                          className="opacity-0 group-hover:opacity-100 hover:opacity-100 focus:opacity-100 p-1"
                          title={t('set_as_default')}
                        >
                          <Star className="w-3 h-3 text-text-muted hover:text-yellow-500" />
                        </button>
                      )}
                      <span
                        className={cn(
                          'w-2 h-2 rounded-full flex-shrink-0',
                          getStatusColor(device.status)
                        )}
                      />
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

            {cloudDevices.length > 0 && (
              <>
                {localDevices.length > 0 && <DropdownMenuSeparator />}
                <div className="px-3 py-1.5 text-xs font-medium text-text-muted bg-surface">
                  {t('cloud_devices_section')}
                </div>
                {cloudDevices.map(device => {
                  const isFull = isDeviceAtCapacity(device.slot_used, device.slot_max)
                  const isBusy = device.status === 'busy'
                  const isSelected = selectedDeviceId === device.device_id

                  return (
                    <DropdownMenuItem
                      key={device.device_id}
                      data-testid={`execution-target-device-${device.device_id}`}
                      onSelect={() => {
                        if (!isFull) {
                          handleDeviceSelect(device.device_id)
                        }
                      }}
                      disabled={isFull}
                      className={cn(
                        'group flex items-center gap-2 cursor-pointer',
                        isSelected && 'bg-accent',
                        isFull && 'opacity-50 cursor-not-allowed'
                      )}
                    >
                      <Server className="w-4 h-4 flex-shrink-0" />
                      <span className="flex-1 truncate text-sm">{device.name}</span>
                      <span
                        className={cn(
                          'text-xs flex-shrink-0',
                          isFull ? 'text-red-500' : 'text-text-muted'
                        )}
                      >
                        {formatSlotUsage(device.slot_used, device.slot_max)}
                      </span>
                      {device.is_default ? (
                        <Star className="w-3 h-3 text-yellow-500 fill-yellow-500 flex-shrink-0" />
                      ) : (
                        <button
                          type="button"
                          onClick={e => void handleSetDefault(e, device.device_id)}
                          className="opacity-0 group-hover:opacity-100 hover:opacity-100 focus:opacity-100 p-1"
                          title={t('set_as_default')}
                        >
                          <Star className="w-3 h-3 text-text-muted hover:text-yellow-500" />
                        </button>
                      )}
                      <span
                        className={cn(
                          'w-2 h-2 rounded-full flex-shrink-0',
                          getStatusColor(device.status)
                        )}
                      />
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

            {selectableDevices.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem
              data-testid="execution-target-cloud-mode"
              onSelect={handleCloudModeSelect}
              className={cn(
                'flex items-center gap-2 cursor-pointer',
                !selectedDeviceId && 'bg-accent'
              )}
            >
              <Cloud className="w-4 h-4 flex-shrink-0" />
              <span className="flex-1 truncate text-sm">{t('cloud_mode')}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {selectedDevice && !isSelectedDeviceAvailable && (
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
