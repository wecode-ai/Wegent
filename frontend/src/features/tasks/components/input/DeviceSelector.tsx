// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * DeviceSelector component for selecting local device or cloud executor
 * in the chat input area.
 */

import { useDevices } from '@/contexts/DeviceContext'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { Monitor, Cloud, ChevronDown, Loader2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

interface DeviceSelectorProps {
  /** Additional className */
  className?: string
  /** Disabled state */
  disabled?: boolean
}

export function DeviceSelector({ className, disabled }: DeviceSelectorProps) {
  const { t } = useTranslation('devices')
  const { devices, selectedDeviceId, setSelectedDeviceId, isLoading } = useDevices()

  // Get selected device info
  const selectedDevice = selectedDeviceId
    ? devices.find(d => d.device_id === selectedDeviceId)
    : null

  // If selected device went offline, show warning
  const isSelectedDeviceAvailable =
    !selectedDeviceId || (selectedDevice && selectedDevice.status !== 'offline')

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

  // Don't render if no devices available
  if (devices.length === 0 && !isLoading) {
    return null
  }

  return (
    <TooltipProvider>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled || isLoading}
                className={cn(
                  'h-8 px-2 gap-1.5 text-text-secondary hover:text-text-primary',
                  !isSelectedDeviceAvailable && 'text-red-500',
                  className
                )}
              >
                {isLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : selectedDeviceId ? (
                  <>
                    <Monitor className="w-4 h-4" />
                    <span className="max-w-[80px] truncate text-xs">
                      {selectedDevice?.name || selectedDeviceId}
                    </span>
                    {selectedDevice && (
                      <span
                        className={cn(
                          'w-1.5 h-1.5 rounded-full',
                          getStatusColor(selectedDevice.status)
                        )}
                      />
                    )}
                  </>
                ) : (
                  <>
                    <Cloud className="w-4 h-4" />
                    <span className="text-xs">{t('cloud_executor')}</span>
                  </>
                )}
                <ChevronDown className="w-3 h-3 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{t('select_device')}</p>
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" className="w-56">
          {/* Cloud executor option */}
          <DropdownMenuItem
            onClick={() => setSelectedDeviceId(null)}
            className={cn('flex items-center gap-2', !selectedDeviceId && 'bg-accent')}
          >
            <Cloud className="w-4 h-4" />
            <span>{t('cloud_executor')}</span>
            {!selectedDeviceId && <span className="ml-auto text-primary">✓</span>}
          </DropdownMenuItem>

          {devices.length > 0 && <DropdownMenuSeparator />}

          {/* Device list */}
          {devices.map(device => {
            const isDisabled = device.status === 'busy'
            const isSelected = selectedDeviceId === device.device_id

            return (
              <Tooltip key={device.device_id}>
                <TooltipTrigger asChild>
                  <DropdownMenuItem
                    onClick={() => !isDisabled && setSelectedDeviceId(device.device_id)}
                    disabled={isDisabled}
                    className={cn(
                      'flex items-center gap-2',
                      isSelected && 'bg-accent',
                      isDisabled && 'opacity-50 cursor-not-allowed'
                    )}
                  >
                    <Monitor className="w-4 h-4" />
                    <span className="flex-1 truncate">{device.name}</span>
                    <span className={cn('w-2 h-2 rounded-full', getStatusColor(device.status))} />
                    {isSelected && <span className="text-primary">✓</span>}
                  </DropdownMenuItem>
                </TooltipTrigger>
                {isDisabled && (
                  <TooltipContent side="right">
                    <p>{t('device_busy_hint')}</p>
                  </TooltipContent>
                )}
              </Tooltip>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
}
