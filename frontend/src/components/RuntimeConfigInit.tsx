// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { fetchRuntimeConfig } from '@/lib/runtime-config'
import { apiClient } from '@/apis/client'

interface RuntimeConfigInitProps {
  children: React.ReactNode
}

/**
 * Initialize runtime configuration before rendering children.
 * This ensures that API URLs are properly configured from server-sidide
 * environment variables before any API calls are made.
 */
export default function RuntimeConfigInit({ children }: RuntimeConfigInitProps) {
  const [initialized, setInitialized] = useState(false)

  useEffect(() => {
    const init = async () => {
      try {
        // Fetch runtime config from server
        await fetchRuntimeConfig()
        // Initialize API client with the fetched config
        await apiClient.initialize()
      } catch (err) {
        console.warn('[RuntimeConfigInit] Failed to initialize:', err)
      } finally {
        setInitialized(true)
      }
    }

    init()
  }, [])

  // Show nothing while initializing to prevent flash of incorrect content
  // This is a very brief moment, typically < 100ms
  if (!initialized) {
    return null
  }

  return <>{children}</>
}
