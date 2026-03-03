// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side noVNC RFB loader
 *
 * Uses dynamic import from local node_modules with webpackIgnore.
 */

'use client'

import type RFB from '@novnc/novnc/lib/rfb'

type RFBConstructor = typeof RFB

/**
 * Load the noVNC RFB class.
 * Uses dynamic import with webpackIgnore to load from node_modules at runtime.
 *
 * @returns Promise<RFB constructor>
 */
export async function loadRFB(): Promise<RFBConstructor> {
  try {
    // Dynamic import with webpackIgnore to bypass bundler issues
    const novnc = await import(
      /* webpackIgnore: true */
      '@novnc/novnc/lib/rfb.js'
    )

    // Handle different export formats
    const RFB = novnc.default || novnc.RFB || novnc

    if (!RFB) {
      console.error('[VNC] Module exports:', Object.keys(novnc))
      throw new Error('RFB class not found in noVNC module')
    }

    return RFB as RFBConstructor
  } catch (error) {
    console.error('[VNC] Failed to load noVNC RFB:', error)
    throw new Error('Failed to load VNC library')
  }
}
