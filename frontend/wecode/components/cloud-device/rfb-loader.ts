// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side noVNC RFB loader
 *
 * This module provides a client-side-only function to load the noVNC RFB class.
 * Separating this into its own module helps avoid SSR issues and module resolution problems.
 */

'use client'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let RFBClass: any = null

/**
 * Load the noVNC RFB class dynamically.
 * This function can be called multiple times - it caches the result after first load.
 *
 * @returns Promise<RFB constructor>
 */
export async function loadRFB() {
  if (RFBClass) {
    return RFBClass
  }

  try {
    // Try importing as ES module
     
    const rfbModule = await import('@novnc/novnc/lib/rfb')
    RFBClass = rfbModule.default || rfbModule
    return RFBClass
  } catch (error) {
    console.error('[VNC] Failed to load noVNC RFB:', error)
    throw new Error('Failed to load VNC library')
  }
}
