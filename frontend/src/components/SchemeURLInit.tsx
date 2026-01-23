// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect } from 'react'
import { initializeSchemeSystem } from '@/lib/scheme'
import { enableDevMode } from '@/lib/scheme/devtools'

/**
 * Initializes the Scheme URL system
 * This component should be mounted once at the app root level
 */
export default function SchemeURLInit() {
  useEffect(() => {
    // Initialize the scheme URL system
    initializeSchemeSystem()

    // Enable dev mode in development
    if (process.env.NODE_ENV === 'development') {
      enableDevMode()
    }
  }, [])

  return null
}
