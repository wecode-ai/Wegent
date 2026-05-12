// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ComputerDesktopIcon } from '@heroicons/react/24/outline'

import type { AdminDeviceInfo } from '@/apis/admin'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

import { DeviceVncPanel } from '@wecode/components/cloud-device'

interface ActiveVncDevice {
  deviceId: string
  userId: number
}

export interface AdminDeviceMonitorVncExtension {
  renderAction: (device: AdminDeviceInfo) => ReactNode
  renderPanel: () => ReactNode
}

/**
 * Internal VNC extension for the admin device monitor.
 *
 * The open-source panel only knows how to call this extension. All VNC-specific
 * state, layout, and rendering stay within the wecode namespace.
 */
export function useAdminDeviceMonitorVncExtension(
  devices: AdminDeviceInfo[]
): AdminDeviceMonitorVncExtension {
  const { t } = useTranslation('devices')
  const isMobile = useIsMobile()
  const [activeVncDevice, setActiveVncDevice] = useState<ActiveVncDevice | null>(null)
  const [isVncFullscreen, setIsVncFullscreen] = useState(false)

  const closeVncPanel = useCallback(() => {
    setActiveVncDevice(null)
    setIsVncFullscreen(false)
  }, [])

  const activeVncDeviceDetails = useMemo(() => {
    if (!activeVncDevice) {
      return null
    }

    return (
      devices.find(
        device =>
          device.device_id === activeVncDevice.deviceId && device.user_id === activeVncDevice.userId
      ) ?? null
    )
  }, [activeVncDevice, devices])

  useEffect(() => {
    if (!activeVncDevice) {
      setIsVncFullscreen(false)
      return
    }

    if (
      !activeVncDeviceDetails ||
      activeVncDeviceDetails.status !== 'online' ||
      activeVncDeviceDetails.device_type !== 'cloud' ||
      activeVncDeviceDetails.bind_shell !== 'claudecode'
    ) {
      closeVncPanel()
    }
  }, [activeVncDevice, activeVncDeviceDetails, closeVncPanel])

  const handleToggleVnc = useCallback((device: AdminDeviceInfo) => {
    setIsVncFullscreen(false)
    setActiveVncDevice(current => {
      if (current?.deviceId === device.device_id && current.userId === device.user_id) {
        return null
      }

      return {
        deviceId: device.device_id,
        userId: device.user_id,
      }
    })
  }, [])

  const renderAction = useCallback(
    (device: AdminDeviceInfo) => {
      if (device.device_type !== 'cloud' || device.bind_shell !== 'claudecode') {
        return null
      }

      const isActive =
        activeVncDevice?.deviceId === device.device_id && activeVncDevice.userId === device.user_id

      return (
        <Tooltip key={`${device.device_id}-vnc`}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'h-8 w-8',
                isActive && 'bg-primary/10 text-primary hover:bg-primary/15'
              )}
              disabled={device.status !== 'online'}
              onClick={() => handleToggleVnc(device)}
              data-testid={`vnc-device-${device.device_id}`}
            >
              <ComputerDesktopIcon className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('vnc_open_desktop')}</TooltipContent>
        </Tooltip>
      )
    },
    [activeVncDevice, handleToggleVnc, t]
  )

  const renderPanel = useCallback(() => {
    if (!activeVncDeviceDetails) {
      return null
    }

    return (
      <div className="mt-4" data-testid="admin-device-vnc-panel">
        <TooltipProvider>
          <DeviceVncPanel
            deviceId={activeVncDeviceDetails.device_id}
            ownerUserId={activeVncDeviceDetails.user_id}
            onClose={closeVncPanel}
            title={`${t('vnc_panel_title')} - ${activeVncDeviceDetails.name}`}
            isFullscreen={isVncFullscreen}
            onToggleFullscreen={() => setIsVncFullscreen(prev => !prev)}
            containerClassName={
              isVncFullscreen
                ? 'w-full h-[70vh] min-h-[70vh]'
                : 'w-full h-[60vh] min-h-[60vh]'
            }
            borderPosition={isMobile ? 'top' : 'left'}
          />
        </TooltipProvider>
      </div>
    )
  }, [activeVncDeviceDetails, closeVncPanel, isMobile, isVncFullscreen, t])

  return {
    renderAction,
    renderPanel,
  }
}
