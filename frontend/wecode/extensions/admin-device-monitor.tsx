// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ComputerDesktopIcon } from '@heroicons/react/24/outline'

import type { AdminDeviceInfo } from '@/apis/admin'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

import { DeviceVncPanel } from '@wecode/components/cloud-device'

export interface AdminDeviceMonitorExtension {
  renderAction: (device: AdminDeviceInfo) => ReactNode
  renderPanel: () => ReactNode
}

function isVncDeviceAvailable(device: AdminDeviceInfo): boolean {
  return (
    device.device_type === 'cloud' && device.bind_shell === 'claudecode'
    // Note: Admin page shows VNC button even for offline devices
  )
}

/**
 * Wecode implementation of the admin device monitor extension.
 *
 * The open-source panel only knows how to call this extension. All VNC-specific
 * state, layout, and rendering stay within the wecode namespace.
 */
export function useAdminDeviceMonitorExtension(
  devices: AdminDeviceInfo[] = []
): AdminDeviceMonitorExtension {
  const { t } = useTranslation('devices')
  const isMobile = useIsMobile()
  const [activeVncDeviceDetails, setActiveVncDeviceDetails] = useState<AdminDeviceInfo | null>(null)
  const [isVncFullscreen, setIsVncFullscreen] = useState(false)

  const closeVncPanel = useCallback(() => {
    setActiveVncDeviceDetails(null)
    setIsVncFullscreen(false)
  }, [])

  const handleToggleVnc = useCallback((device: AdminDeviceInfo) => {
    setIsVncFullscreen(false)
    setActiveVncDeviceDetails(current => {
      if (current?.device_id === device.device_id && current.user_id === device.user_id) {
        return null
      }

      return device
    })
  }, [])

  useEffect(() => {
    if (!activeVncDeviceDetails) {
      return
    }

    const activeDeviceStillAvailable = devices.some(device => {
      return (
        device.device_id === activeVncDeviceDetails.device_id &&
        device.user_id === activeVncDeviceDetails.user_id &&
        isVncDeviceAvailable(device)
      )
    })

    if (!activeDeviceStillAvailable) {
      closeVncPanel()
    }
  }, [activeVncDeviceDetails, closeVncPanel, devices])

  const renderAction = useCallback(
    (device: AdminDeviceInfo) => {
      if (!isVncDeviceAvailable(device)) {
        return null
      }

      const isActive =
        activeVncDeviceDetails?.device_id === device.device_id &&
        activeVncDeviceDetails.user_id === device.user_id

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
              disabled={false}
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
    [activeVncDeviceDetails, handleToggleVnc, t]
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
              isVncFullscreen ? 'w-full h-[70vh] min-h-[70vh]' : 'w-full h-[60vh] min-h-[60vh]'
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
