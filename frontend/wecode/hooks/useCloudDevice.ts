// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Cloud Device Hook
 *
 * Reusable hook for cloud device operations.
 * Provides configuration fetching and device creation logic.
 */

'use client'

import { useState, useEffect, useCallback } from 'react'
import { cloudDeviceApis, CloudDeviceConfig } from '@wecode/apis/cloud-devices'

interface CreateDeviceBody {
  mail_email?: string
  mail_password?: string
}

export function useCloudDevice() {
  const [config, setConfig] = useState<CloudDeviceConfig | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  // Fetch cloud device configuration
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const fetchedConfig = await cloudDeviceApis.getCloudDeviceConfig()
        setConfig(fetchedConfig)
      } catch (err) {
        console.error('Failed to fetch cloud device config:', err)
        setError(err as Error)
      }
    }
    fetchConfig()
  }, [])

  // Create cloud device
  const createDevice = useCallback(async (body?: CreateDeviceBody) => {
    setIsCreating(true)
    setError(null)
    try {
      await cloudDeviceApis.createCloudDevice(body)
    } catch (err) {
      setError(err as Error)
      throw err
    } finally {
      setIsCreating(false)
    }
  }, [])

  return {
    config,
    createDevice,
    isCreating,
    error,
  }
}
