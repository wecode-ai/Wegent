// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react'

import { useTranslation } from '@/hooks/useTranslation'
import type { DeviceChatSidecar, DeviceChatSidecarOptions } from '@/extensions/device-chat-sidecar'
import { CloudDeviceVncPanel, DeviceVncPanel } from '@wecode/components/cloud-device'
import { useDeviceVncState } from '@wecode/hooks'

/**
 * Wecode implementation of the device chat sidecar.
 *
 * The open-source device chat page only knows how to mount this sidecar. All
 * VNC-specific state, layout, and rendering stay within the wecode namespace.
 */
export function useDeviceChatSidecar({
  selectedDevice,
  selectedDeviceId,
  isMobile,
  hideFilesTab,
}: DeviceChatSidecarOptions): DeviceChatSidecar {
  const { t } = useTranslation('devices')
  const { isCloudDevice, isVncOpen, sandboxId, setIsVncOpen, handleToggleVnc } = useDeviceVncState({
    selectedDevice,
    selectedDeviceId,
  })
  const [fullscreen, setFullscreen] = useState(false)

  const reset = useCallback(() => {
    setIsVncOpen(false)
    setFullscreen(false)
  }, [setIsVncOpen])

  const closePanel = useCallback(() => setIsVncOpen(false), [setIsVncOpen])

  // The panel needs a cloud device with a sandbox on a non-mobile layout.
  const open = Boolean(isVncOpen && sandboxId && selectedDeviceId && !isMobile)

  return {
    toolbar:
      isCloudDevice && sandboxId ? (
        <CloudDeviceVncPanel isVncOpen={isVncOpen} onToggleVnc={handleToggleVnc} />
      ) : null,
    panel:
      open && selectedDeviceId ? (
        <DeviceVncPanel
          deviceId={selectedDeviceId}
          hideFilesTab={hideFilesTab}
          onClose={closePanel}
          title={t('vnc_panel_title')}
          closeLabel={t('vnc_close')}
          isFullscreen={fullscreen}
          onToggleFullscreen={() => setFullscreen(previous => !previous)}
          fullscreenLabel={t('vnc_fullscreen')}
          exitFullscreenLabel={t('vnc_exit_fullscreen')}
        />
      ) : null,
    open,
    fullscreen,
    reset,
  }
}
