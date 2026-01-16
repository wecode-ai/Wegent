// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser notification utility
 */

const NOTIFICATION_PERMISSION_KEY = 'wegent_notification_enabled'

/**
 * Check if browser notifications are supported
 */
export function isNotificationSupported(): boolean {
  return 'Notification' in window
}

/**
 * Get user's notification preference
 */
export function isNotificationEnabled(): boolean {
  if (!isNotificationSupported()) return false
  const stored = localStorage.getItem(NOTIFICATION_PERMISSION_KEY)
  return stored === 'true'
}

/**
 * Set user's notification preference
 */
export function setNotificationEnabled(enabled: boolean): void {
  localStorage.setItem(NOTIFICATION_PERMISSION_KEY, enabled ? 'true' : 'false')
}

/**
 * Request notification permission from user
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!isNotificationSupported()) {
    return false
  }

  if (Notification.permission === 'granted') {
    setNotificationEnabled(true)
    return true
  }

  if (Notification.permission === 'denied') {
    return false
  }

  try {
    const permission = await Notification.requestPermission()
    const granted = permission === 'granted'
    setNotificationEnabled(granted)
    return granted
  } catch (error) {
    console.error('Failed to request notification permission:', error)
    return false
  }
}

/**
 * Send a browser notification
 */
export async function sendNotification(
  title: string,
  options?: NotificationOptions,
  targetUrl?: string
): Promise<void> {
  if (!isNotificationSupported()) return
  if (Notification.permission !== 'granted') return
  if (!isNotificationEnabled()) return

  try {
    // Try to use Service Worker for better tab matching
    if ('serviceWorker' in navigator && targetUrl) {
      try {
        const registration = await navigator.serviceWorker.ready
        await registration.showNotification(title, {
          icon: '/favicon.ico',
          badge: '/favicon.ico',
          ...options,
          data: {
            ...options?.data,
            targetUrl,
          },
        })
        return
      } catch (swError) {
        console.warn(
          'Failed to use Service Worker notification, falling back to basic notification:',
          swError
        )
      }
    }

    // Fallback to basic notification
    const notification = new Notification(title, {
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      ...options,
    })

    // Add click handler for navigation
    if (targetUrl) {
      notification.onclick = event => {
        event.preventDefault()
        window.open(targetUrl, '_blank')?.focus()
        notification.close()
      }
    }

    // Auto close after 5 seconds
    setTimeout(() => notification.close(), 5000)
  } catch (error) {
    console.error('Failed to send notification:', error)
  }
}

/**
 * Send task completion notification
 */
export function notifyTaskCompletion(
  taskId: number,
  taskTitle: string,
  success: boolean,
  taskType?: 'chat' | 'code'
): void {
  const title = success ? '✅ Task Completed' : '❌ Task Failed'
  const body = taskTitle.length > 100 ? `${taskTitle.substring(0, 100)}...` : taskTitle

  // Build target URL based on task type
  const targetUrl =
    taskType === 'code'
      ? `${window.location.origin}/code?taskId=${taskId}`
      : `${window.location.origin}/chat?taskId=${taskId}`

  sendNotification(
    title,
    {
      body,
      tag: 'task-completion',
      requireInteraction: false,
    },
    targetUrl
  )
}
