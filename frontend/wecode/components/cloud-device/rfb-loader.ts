// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side noVNC RFB loader
 *
 * Uses ES module dynamic import to load noVNC reliably.
 */

'use client'

import type RFB from '@novnc/novnc/lib/rfb'

type RFBConstructor = typeof RFB

/**
 * Load the noVNC RFB class.
 * This function can be called multiple times - it caches the result after first load.
 *
 * @returns Promise<RFB constructor>
 */
export async function loadRFB(): Promise<RFBConstructor> {
  try {
    // Use ES module dynamic import for proper module resolution
    const novnc = await import('@novnc/novnc/lib/rfb')
    // Handle both ESM default export and CommonJS module.exports
    const RFB = novnc.default || novnc
    if (!RFB) {
      throw new Error('RFB class not found in @novnc/novnc module')
    }
    return RFB as RFBConstructor
  } catch (error) {
    console.error('[VNC] Failed to load noVNC RFB:', error)
    throw new Error('Failed to load VNC library')
  }
}
