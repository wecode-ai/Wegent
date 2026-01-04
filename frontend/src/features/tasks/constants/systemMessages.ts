// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * System message markers for internal use only.
 * These messages should be filtered out from user-facing message lists.
 */
export const SYSTEM_MESSAGE_MARKERS = {
  /** Marker used when creating a group chat to avoid showing initial message */
  GROUP_CHAT_CREATED: '__SYSTEM_GROUP_CREATED__',
} as const

export type SystemMessageMarker =
  (typeof SYSTEM_MESSAGE_MARKERS)[keyof typeof SYSTEM_MESSAGE_MARKERS]

/**
 * Check if a message content is a system marker that should be hidden from display.
 * @param content - The message content to check
 * @returns true if the content is a system marker
 */
export function isSystemMessage(content: string): boolean {
  return Object.values(SYSTEM_MESSAGE_MARKERS).includes(content as SystemMessageMarker)
}
