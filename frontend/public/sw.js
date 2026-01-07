// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Service Worker for handling notification click events
 * Implements tab matching and activation functionality
 */

// Handle notification click events
self.addEventListener('notificationclick', event => {
  event.notification.close()

  const targetUrl = event.notification.data?.targetUrl

  if (!targetUrl) {
    return
  }

  event.waitUntil(
    (async () => {
      // Get all window clients
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })

      // Try to find an existing tab with exact URL match
      for (const client of clients) {
        if (client.url === targetUrl) {
          // Found matching tab, focus it
          await client.focus()
          return
        }
      }

      // No matching tab found, open new window
      await self.clients.openWindow(targetUrl)
    })()
  )
})

// Minimal service worker - no caching, no other PWA features
// Just handle notification clicks
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim())
})
