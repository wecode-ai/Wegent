// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser notification utility
 */

const NOTIFICATION_PERMISSION_KEY = 'wegent_notification_enabled';

/**
 * Check if browser notifications are supported
 */
export function isNotificationSupported(): boolean {
  return 'Notification' in window;
}

/**
 * Get user's notification preference
 */
export function isNotificationEnabled(): boolean {
  if (!isNotificationSupported()) return false;
  const stored = localStorage.getItem(NOTIFICATION_PERMISSION_KEY);
  return stored === 'true';
}

/**
 * Set user's notification preference
 */
export function setNotificationEnabled(enabled: boolean): void {
  localStorage.setItem(NOTIFICATION_PERMISSION_KEY, enabled ? 'true' : 'false');
}

/**
 * Request notification permission from user
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!isNotificationSupported()) {
    return false;
  }

  if (Notification.permission === 'granted') {
    setNotificationEnabled(true);
    return true;
  }

  if (Notification.permission === 'denied') {
    return false;
  }

  try {
    const permission = await Notification.requestPermission();
    const granted = permission === 'granted';
    setNotificationEnabled(granted);
    return granted;
  } catch (error) {
    console.error('Failed to request notification permission:', error);
    return false;
  }
}

/**
 * Send a browser notification
 */
export function sendNotification(title: string, options?: NotificationOptions): void {
  if (!isNotificationSupported()) return;
  if (Notification.permission !== 'granted') return;
  if (!isNotificationEnabled()) return;

  try {
    const notification = new Notification(title, {
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      ...options,
    });

    // Auto close after 5 seconds
    setTimeout(() => notification.close(), 5000);
  } catch (error) {
    console.error('Failed to send notification:', error);
  }
}

/**
 * Send task completion notification
 */
export function notifyTaskCompletion(taskTitle: string, success: boolean): void {
  const title = success ? '✅ Task Completed' : '❌ Task Failed';
  const body = taskTitle.length > 100 ? `${taskTitle.substring(0, 100)}...` : taskTitle;

  sendNotification(title, {
    body,
    tag: 'task-completion',
    requireInteraction: false,
  });
}
