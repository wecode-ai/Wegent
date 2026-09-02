// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import { getShowAdvancedDevices, saveShowAdvancedDevices } from '@/utils/userPreferences'

export function useAdvancedDeviceMode() {
  const [showAdvancedDevices, setShowAdvancedDevicesState] = useState(false)
  const [isAdvancedDeviceModeReady, setIsAdvancedDeviceModeReady] = useState(false)

  useEffect(() => {
    setShowAdvancedDevicesState(getShowAdvancedDevices())
    setIsAdvancedDeviceModeReady(true)
  }, [])

  const setShowAdvancedDevices = useCallback((show: boolean) => {
    setShowAdvancedDevicesState(show)
    saveShowAdvancedDevices(show)
  }, [])

  return {
    showAdvancedDevices,
    setShowAdvancedDevices,
    isAdvancedDeviceModeReady,
  }
}
