// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side noVNC RFB loader
 *
 * Uses ES module dynamic import from esm.sh CDN to load noVNC.
 */

'use client'

import type RFB from '@novnc/novnc/lib/rfb'

type RFBConstructor = typeof RFB

/**
 * Load the noVNC RFB class.
 * Uses esm.sh CDN which provides proper ES module wrapping.
 *
 * @returns Promise<RFB constructor>
 */
export async function loadRFB(): Promise<RFBConstructor> {
  try {
    // Use esm.sh which wraps npm packages as ES modules
    const novnc = await import('https://esm.sh/@novnc/novnc@1.6.0/lib/rfb.js')
    // Handle both ESM default export and named exports
    const RFB = novnc.default || novnc.RFB || novnc
    if (!RFB) {
      throw new Error('RFB class not found in @novnc/novnc module')
    }
    return RFB as RFBConstructor
  } catch (error) {
    console.error('[VNC] Failed to load noVNC RFB:', error)
    throw new Error('Failed to load VNC library')
  }
}
