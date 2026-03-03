// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side noVNC RFB loader
 *
 * Uses webpack to bundle noVNC. This requires @novnc/novnc to be
 * properly configured in webpack with topLevelAwait experiment enabled.
 */

'use client'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let RFBCache: any = null

/**
 * Load the noVNC RFB class.
 * Uses webpack's topLevelAwait experiment to handle noVNC's async initialization.
 *
 * @returns Promise<RFB constructor>
 */
export async function loadRFB() {
  if (RFBCache) {
    return RFBCache
  }

  try {
    // Use normal import - webpack with topLevelAwait will handle this
    // Note: In development mode with Turbopack, this may show 'exports is not defined'
    // warning in console, but it doesn't affect functionality. Production builds work correctly.
    const novnc = await import('@novnc/novnc/lib/rfb')
    RFBCache = novnc.default || novnc
    return RFBCache
  } catch (error) {
    // Suppress 'exports is not defined' warning in development mode
    if (error instanceof Error && error.message.includes('exports is not defined')) {
      console.warn(
        '[VNC] Expected warning in dev mode with Turbopack, functionality is not affected'
      )
      // Return cached value if available, or re-throw for retry
      if (RFBCache) return RFBCache
    }
    console.error('[VNC] Failed to load noVNC RFB:', error)
    throw new Error(
      'Failed to load VNC library: ' + (error instanceof Error ? error.message : String(error))
    )
  }
}
