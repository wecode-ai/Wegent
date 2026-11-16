// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useRef, useState } from 'react'
import {
  isDeviceInteractiveSessionEnabled,
  supportsCloudSessions,
  supportsRemoteSessions,
} from '@wegent/chat-core/device-capabilities'
import { toast } from 'sonner'
import { deviceApis, type DeviceInfo } from '@/apis/devices'
import { useTranslation } from '@/hooks/useTranslation'

function isBrowserUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export function useDeviceIde(device: DeviceInfo | undefined, lifecyclePending = false) {
  const { t } = useTranslation('devices')
  const openingDevices = useRef(new Set<string>())
  const [openingDeviceIds, setOpeningDeviceIds] = useState<ReadonlySet<string>>(new Set())

  if (
    !device ||
    (device.device_type !== 'cloud' && device.device_type !== 'remote') ||
    !(
      supportsCloudSessions(device, device.device_id) ||
      supportsRemoteSessions(device, device.device_id)
    )
  ) {
    return null
  }

  const deviceId = device.device_id
  const disabledReason = lifecyclePending
    ? t('ide.device_restarting')
    : device.status === 'offline'
      ? t('ide.device_offline')
      : !isDeviceInteractiveSessionEnabled(device, 'codeServer')
        ? t('ide.disabled_on_device')
        : undefined

  const open = async () => {
    if (disabledReason || openingDevices.current.has(deviceId)) return

    // Reserve the tab during the click, before waiting for the session URL.
    const tab = window.open('about:blank', '_blank')
    if (!tab) {
      toast.error(t('ide.popup_blocked'))
      return
    }
    tab.opener = null
    openingDevices.current.add(deviceId)
    setOpeningDeviceIds(new Set(openingDevices.current))

    try {
      const { url } = await deviceApis.startCodeServer(deviceId)
      if (tab.closed) return
      if (!isBrowserUrl(url)) {
        tab.close()
        toast.error(t('ide.invalid_url'))
        return
      }
      tab.location.replace(url)
    } catch {
      tab.close()
      toast.error(t('ide.start_failed'))
    } finally {
      openingDevices.current.delete(deviceId)
      setOpeningDeviceIds(new Set(openingDevices.current))
    }
  }

  return {
    label: t('ide.open'),
    disabledReason,
    opening: openingDeviceIds.has(deviceId),
    open,
  }
}
