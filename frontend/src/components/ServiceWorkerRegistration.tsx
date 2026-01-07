// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect } from 'react'

/**
 * Component to register Service Worker for notification handling
 * Runs only on client-side
 */
export default function ServiceWorkerRegistration() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
      return
    }

    // Register the service worker
    navigator.serviceWorker
      .register('/sw.js', {
        scope: '/',
      })
      .then(registration => {
        console.log('Service Worker registered successfully:', registration)
      })
      .catch(error => {
        console.error('Service Worker registration failed:', error)
      })
  }, [])

  return null // This component doesn't render anything
}
