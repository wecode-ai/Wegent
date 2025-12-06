// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Send shortcut preference utility
 * Allows users to choose between Enter or Cmd/Ctrl+Enter to send messages
 */

export type SendShortcutMode = 'enter' | 'cmd-enter'

const SEND_SHORTCUT_KEY = 'wegent_send_shortcut_mode'

/**
 * Get user's send shortcut preference
 * @returns The preferred send shortcut mode, defaults to 'enter'
 */
export function getSendShortcutMode(): SendShortcutMode {
  if (typeof window === 'undefined') return 'enter'
  const stored = localStorage.getItem(SEND_SHORTCUT_KEY)
  if (stored === 'cmd-enter') return 'cmd-enter'
  return 'enter'
}

/**
 * Set user's send shortcut preference
 * @param mode The send shortcut mode to set
 */
export function setSendShortcutMode(mode: SendShortcutMode): void {
  localStorage.setItem(SEND_SHORTCUT_KEY, mode)
}

/**
 * Check if the key event should trigger sending a message
 * @param e The keyboard event
 * @param mode The current send shortcut mode
 * @returns Whether the message should be sent
 */
export function shouldSendMessage(
  e: React.KeyboardEvent | KeyboardEvent,
  mode: SendShortcutMode
): boolean {
  if (e.key !== 'Enter') return false

  if (mode === 'enter') {
    // Enter sends, Shift+Enter for new line
    return !e.shiftKey && !e.metaKey && !e.ctrlKey
  } else {
    // Cmd/Ctrl+Enter sends
    return e.metaKey || e.ctrlKey
  }
}

/**
 * Get the shortcut display text based on mode and platform
 * @param mode The send shortcut mode
 * @returns Display text for the shortcut
 */
export function getShortcutDisplayText(mode: SendShortcutMode): {
  send: string
  newLine: string
} {
  const isMac =
    typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0

  if (mode === 'enter') {
    return {
      send: 'Enter',
      newLine: 'Shift+Enter',
    }
  } else {
    return {
      send: isMac ? '⌘+Enter' : 'Ctrl+Enter',
      newLine: 'Enter',
    }
  }
}
