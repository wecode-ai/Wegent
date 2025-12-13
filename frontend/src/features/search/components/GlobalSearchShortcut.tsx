// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useGlobalSearchShortcut } from '@/features/search'

/**
 * Global search shortcut provider component
 * This adds the Cmd+K / Ctrl+K keyboard shortcut globally
 */
export function GlobalSearchShortcut() {
  useGlobalSearchShortcut()
  return null
}
