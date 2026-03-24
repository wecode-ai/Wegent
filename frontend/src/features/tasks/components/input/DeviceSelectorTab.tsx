// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * DeviceSelectorTab component for selecting execution target in the chat input area.
 *
 * Features:
 * - Card-based device selector with Popover for better multi-device visualization
 * - Shows device count and online status in trigger button
 * - Grid layout for device cards with rich information
 * - Cloud mode option for serverless execution
 * - Set default execution target (saved to server)
 * - Read-only state for existing chats
 */

import { useMemo, useRef, useEffect, useCallback, useState } from 'react'
import type { MouseEvent } from 'react'
import { useDevices } from '@/contexts/DeviceContext'
import { useUser } from '@/features/common/UserContext'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import {
  Monitor,
  Cloud,
  ChevronDown,
  AlertCircle,
  Server,
  Check,
  Settings,
  Cpu,
} from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  formatSlotUsage,
  getSelectableDevices,
  getStatusColor,
  isDeviceAtCapacity,
} from '@/features/devices/utils/execution-target'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { paths } from '@/config/paths'
import type { DeviceInfo } from '@/apis/devices'

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

/**
 * Device card component for the selector grid
 */
function DeviceCard({
  device,
  isSelected,
  isDefault,
  disabled,
  onSelect,
  onSetDefault,
}: {
  device: DeviceInfo
  isSelected: boolean
  isDefault: boolean
  disabled: boolean
  onSelect: () => void
  onSetDefault: (e: MouseEvent<HTMLButtonElement>) => void
}) {
  const { t } = useTranslation('devices')
  const isFull = isDeviceAtCapacity(device.slot_used, device.slot_max)
  const isOffline = device.status === 'offline'
  const isDisabled = disabled || isFull || isOffline

  return (
    <button
      type="button"
      onClick={() => !isDisabled && onSelect()}
      disabled={isDisabled}
      data-testid={`device-card-${device.device_id}`}
      className={cn(
        'group relative flex flex-col p-3 rounded-lg border-2 transition-all text-left w-full min-h-[88px]',
        'hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/20',
        isSelected
          ? 'border-primary bg-primary/5'
          : 'border-border hover:border-primary/40 bg-surface',
        isDisabled && 'opacity-50 cursor-not-allowed hover:border-border'
      )}
    >
      {/* Selected indicator */}
      {isSelected && (
        <div className="absolute top-2 right-2">
          <Check className="w-4 h-4 text-primary" />
        </div>
      )}

      {/* Device icon and name */}
      <div className="flex items-start gap-2 mb-2 pr-6">
        {device.device_type === 'cloud' ? (
          <Server className="w-5 h-5 text-text-secondary flex-shrink-0 mt-0.5" />
        ) : (
          <Monitor className="w-5 h-5 text-text-secondary flex-shrink-0 mt-0.5" />
        )}
        <span className="font-medium text-sm text-text-primary break-all line-clamp-2">
          {device.name}
        </span>
      </div>

      {/* Status and slots / default button */}
      <div className="flex items-center justify-between mt-auto">
        <div className="flex items-center gap-1.5">
          <span className={cn('w-2 h-2 rounded-full', getStatusColor(device.status))} />
          <span className="text-xs text-text-muted">
            {device.status === 'online'
              ? t('status_online')
              : device.status === 'busy'
                ? t('status_busy')
                : t('status_offline')}
          </span>
          <span className={cn('text-xs', isFull ? 'text-red-500' : 'text-text-muted')}>
            {formatSlotUsage(device.slot_used, device.slot_max)}
          </span>
        </div>
        {/* Default button or indicator */}
        {isDefault ? (
          <span className="px-1.5 py-0.5 rounded text-[10px] text-primary bg-primary/10">
            {t('default_device')}
          </span>
        ) : (
          <button
            type="button"
            onClick={onSetDefault}
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 px-2 py-0.5 rounded border border-border bg-surface text-[10px] text-text-secondary hover:text-primary hover:border-primary/40 hover:bg-primary/5 transition-all"
            data-testid={`set-default-device-${device.device_id}`}
          >
            {t('set_as_default')}
          </button>
        )}
      </div>
    </button>
  )
}

/**
 * Cloud mode card component
 */
function CloudModeCard({
  isSelected,
  isDefault,
  disabled,
  onSelect,
  onSetDefault,
}: {
  isSelected: boolean
  isDefault: boolean
  disabled: boolean
  onSelect: () => void
  onSetDefault: (e: MouseEvent<HTMLButtonElement>) => void
}) {
  const { t } = useTranslation('devices')

  return (
    <button
      type="button"
      onClick={() => !disabled && onSelect()}
      disabled={disabled}
      data-testid="cloud-mode-card"
      className={cn(
        'group relative flex flex-col p-3 rounded-lg border-2 transition-all text-left w-full min-h-[88px]',
        'hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/20',
        isSelected
          ? 'border-primary bg-primary/5'
          : 'border-border hover:border-primary/40 bg-surface',
        disabled && 'opacity-50 cursor-not-allowed hover:border-border'
      )}
    >
      {/* Selected indicator */}
      {isSelected && (
        <div className="absolute top-2 right-2">
          <Check className="w-4 h-4 text-primary" />
        </div>
      )}

      {/* Cloud icon and name */}
      <div className="flex items-center gap-2 mb-2">
        <Cloud className="w-5 h-5 text-primary flex-shrink-0" />
        <span className="font-medium text-sm text-text-primary">{t('cloud_mode')}</span>
      </div>

      {/* Description and default button */}
      <div className="flex items-center justify-between mt-auto">
        <span className="text-xs text-text-muted">{t('cloud_mode_description')}</span>
        {/* Default button or indicator */}
        {isDefault ? (
          <span className="px-1.5 py-0.5 rounded text-[10px] text-primary bg-primary/10 flex-shrink-0">
            {t('default_device')}
          </span>
        ) : (
          <button
            type="button"
            onClick={onSetDefault}
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 px-2 py-0.5 rounded border border-border bg-surface text-[10px] text-text-secondary hover:text-primary hover:border-primary/40 hover:bg-primary/5 transition-all flex-shrink-0"
            data-testid="set-default-cloud-mode"
          >
            {t('set_as_default')}
          </button>
        )}
      </div>
    </button>
  )
}

export function DeviceSelectorTab({
  className,
  disabled,
  hasMessages = false,
  taskDeviceId,
}: DeviceSelectorTabProps) {
  const { t } = useTranslation('devices')
  const router = useRouter()
  const { user, updatePreferences } = useUser()
  const { devices, selectedDeviceId, setSelectedDeviceId, isLoading } = useDevices()
  const autoSelectionInitializedRef = useRef(false)
  const [isOpen, setIsOpen] = useState(false)
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const closeTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Handle hover open with delay
  const handleMouseEnter = useCallback(() => {
    if (disabled || isLoading || hasMessages) return
    // Clear any pending close timeout
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current)
      closeTimeoutRef.current = null
    }
    // Open after a short delay to prevent accidental triggers
    hoverTimeoutRef.current = setTimeout(() => {
      setIsOpen(true)
    }, 150)
  }, [disabled, isLoading, hasMessages])

  // Handle hover close with delay
  const handleMouseLeave = useCallback(() => {
    // Clear any pending open timeout
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current)
      hoverTimeoutRef.current = null
    }
    // Close after a delay to allow moving to the popover content
    closeTimeoutRef.current = setTimeout(() => {
      setIsOpen(false)
    }, 300)
  }, [])

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current)
      if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current)
    }
  }, [])

  // Get user's default execution target preference
  const defaultExecutionTarget = user?.preferences?.default_execution_target

  const selectableDevices = useMemo(() => getSelectableDevices(devices), [devices])

  // Count online devices
  const onlineDeviceCount = useMemo(
    () => selectableDevices.filter(d => d.status !== 'offline').length,
    [selectableDevices]
  )

  // Get preferred device based on user preference or fallback to first available
  const preferredDevice = useMemo(() => {
    // If user has set a default execution target
    if (defaultExecutionTarget) {
      if (defaultExecutionTarget === 'cloud') {
        return null // Cloud mode
      }
      // Find the device by ID
      const device = selectableDevices.find(d => d.device_id === defaultExecutionTarget)
      if (device && !isDeviceAtCapacity(device.slot_used, device.slot_max)) {
        return device
      }
    }
    // Fallback: find first available device that is default or online
    const defaultDevice = selectableDevices.find(
      d => d.is_default && !isDeviceAtCapacity(d.slot_used, d.slot_max)
    )
    if (defaultDevice) return defaultDevice

    return (
      selectableDevices.find(
        d => d.status === 'online' && !isDeviceAtCapacity(d.slot_used, d.slot_max)
      ) || null
    )
  }, [selectableDevices, defaultExecutionTarget])

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
    // Use user's default preference
    if (defaultExecutionTarget === 'cloud') {
      setSelectedDeviceId(null)
    } else {
      setSelectedDeviceId(preferredDevice?.device_id || null)
    }
  }, [
    hasMessages,
    isLoading,
    preferredDevice,
    selectedDeviceId,
    setSelectedDeviceId,
    defaultExecutionTarget,
  ])

  const isSelectedDeviceAvailable = useMemo(() => {
    if (!selectedDevice) return true
    return selectedDevice.status !== 'offline'
  }, [selectedDevice])

  const handleDeviceSelect = (deviceId: string) => {
    if (disabled || hasMessages || isLoading) return
    autoSelectionInitializedRef.current = true
    setSelectedDeviceId(deviceId)
    setIsOpen(false)
  }

  const handleCloudModeSelect = () => {
    if (disabled || hasMessages || isLoading) return
    autoSelectionInitializedRef.current = true
    setSelectedDeviceId(null)
    setIsOpen(false)
  }

  // Set default execution target (saved to server)
  const handleSetDefaultTarget = useCallback(
    async (e: MouseEvent<HTMLButtonElement>, target: string) => {
      e.stopPropagation()
      e.preventDefault()
      try {
        await updatePreferences({ default_execution_target: target })
        toast.success(t('default_target_saved'))
      } catch {
        toast.error(t('default_target_save_failed'))
      }
    },
    [updatePreferences, t]
  )

  // Navigate to device management page
  const handleManageDevices = () => {
    setIsOpen(false)
    router.push(paths.devices.getHref())
  }

  const renderTriggerContent = () => {
    // Show device count summary
    const totalDevices = selectableDevices.length

    if (selectedDevice) {
      const devicePrefix =
        selectedDevice.device_type === 'cloud' ? t('cloud_device_prefix') : t('local_device_prefix')
      const displayName = `${devicePrefix}${selectedDevice.name}`

      return (
        <>
          {selectedDevice.device_type === 'cloud' ? (
            <Server className="w-3.5 h-3.5 text-primary flex-shrink-0" />
          ) : (
            <Monitor className="w-3.5 h-3.5 text-primary flex-shrink-0" />
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="max-w-[200px] truncate">{displayName}</span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[300px]">
              <p className="break-all">{displayName}</p>
            </TooltipContent>
          </Tooltip>
          <span
            className={cn(
              'w-1.5 h-1.5 rounded-full flex-shrink-0',
              getStatusColor(selectedDevice.status)
            )}
          />
          {totalDevices > 0 && (
            <span className="text-text-muted text-[10px] ml-0.5 flex-shrink-0">
              {onlineDeviceCount}/{totalDevices}
            </span>
          )}
        </>
      )
    }

    return (
      <>
        <Cloud className="w-3.5 h-3.5 text-primary" />
        <span>{t('cloud_mode')}</span>
        {totalDevices > 0 && (
          <span className="text-text-muted text-[10px] ml-0.5">
            {onlineDeviceCount}/{totalDevices}
          </span>
        )}
      </>
    )
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
              {selectedDevice ? (
                <>
                  {selectedDevice.device_type === 'cloud' ? (
                    <Server className="w-3.5 h-3.5" />
                  ) : (
                    <Monitor className="w-3.5 h-3.5" />
                  )}
                  <span className="truncate max-w-[160px]">
                    {selectedDevice.device_type === 'cloud'
                      ? t('cloud_device_prefix')
                      : t('local_device_prefix')}
                    {selectedDevice.name}
                  </span>
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
                  <span>{t('cloud_mode')}</span>
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
        ref={containerRef}
        className={cn(
          'flex items-center overflow-hidden',
          disabled && 'opacity-50 cursor-not-allowed',
          className
        )}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <Popover open={isOpen} onOpenChange={setIsOpen}>
          <PopoverTrigger asChild>
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
              {renderTriggerContent()}
              <ChevronDown
                className={cn(
                  'w-3 h-3 opacity-70 transition-transform duration-200',
                  isOpen && 'rotate-180'
                )}
              />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            sideOffset={8}
            className="w-[400px] p-0 bg-base border border-border shadow-lg"
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-primary" />
                <span className="font-medium text-sm">{t('select_execution_target')}</span>
              </div>
              <button
                type="button"
                onClick={handleManageDevices}
                className="flex items-center gap-1 text-xs text-primary hover:underline"
                data-testid="manage-devices-link"
              >
                <Settings className="w-3.5 h-3.5" />
                {t('manage_devices')}
              </button>
            </div>

            {/* Device grid */}
            <div className="p-4 space-y-4 max-h-[400px] overflow-y-auto">
              {/* Local devices section */}
              {localDevices.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-xs font-medium text-text-muted">
                    <Monitor className="w-3.5 h-3.5" />
                    {t('local_devices_section')}
                    <span className="text-text-muted/60">({localDevices.length})</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {localDevices.map(device => (
                      <DeviceCard
                        key={device.device_id}
                        device={device}
                        isSelected={selectedDeviceId === device.device_id}
                        isDefault={defaultExecutionTarget === device.device_id}
                        disabled={disabled || isLoading}
                        onSelect={() => handleDeviceSelect(device.device_id)}
                        onSetDefault={e => void handleSetDefaultTarget(e, device.device_id)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Cloud devices section */}
              {cloudDevices.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-xs font-medium text-text-muted">
                    <Server className="w-3.5 h-3.5" />
                    {t('cloud_devices_section')}
                    <span className="text-text-muted/60">({cloudDevices.length})</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {cloudDevices.map(device => (
                      <DeviceCard
                        key={device.device_id}
                        device={device}
                        isSelected={selectedDeviceId === device.device_id}
                        isDefault={defaultExecutionTarget === device.device_id}
                        disabled={disabled || isLoading}
                        onSelect={() => handleDeviceSelect(device.device_id)}
                        onSetDefault={e => void handleSetDefaultTarget(e, device.device_id)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Cloud mode option */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs font-medium text-text-muted">
                  <Cloud className="w-3.5 h-3.5" />
                  {t('cloud_executor')}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <CloudModeCard
                    isSelected={!selectedDeviceId}
                    isDefault={defaultExecutionTarget === 'cloud'}
                    disabled={disabled || isLoading}
                    onSelect={handleCloudModeSelect}
                    onSetDefault={e => void handleSetDefaultTarget(e, 'cloud')}
                  />
                </div>
              </div>

              {/* Empty state hint */}
              {selectableDevices.length === 0 && (
                <div className="text-center py-4">
                  <p className="text-sm text-text-muted mb-2">{t('no_devices_available')}</p>
                  <button
                    type="button"
                    onClick={handleManageDevices}
                    className="text-sm text-primary hover:underline"
                  >
                    {t('add_device')}
                  </button>
                </div>
              )}
            </div>

            {/* Footer hint */}
            <div className="px-4 py-2.5 border-t border-border bg-surface/50">
              <p className="text-xs text-text-muted flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5" />
                {t('multi_device_hint')}
              </p>
            </div>
          </PopoverContent>
        </Popover>

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
