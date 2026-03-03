// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side noVNC RFB loader
 *
 * Uses Skypack CDN which provides proper ES module wrapping for browser use.
 */

'use client'

// Global type definition for noVNC
declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    noVNC?: { RFB: any }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RFB?: any
  }
}

/**
 * Load the noVNC RFB class.
 * Uses dynamic import with Skypack CDN (bypasses bundler).
 *
 * @returns Promise<RFB constructor>
 */
export async function loadRFB() {
  // Check if already loaded globally
  if (typeof window !== 'undefined' && window.noVNC?.RFB) {
    return window.noVNC.RFB
  }

  try {
    // Use Skypack CDN with ?module to force ES module format
    const novncModule = await import(
      /* webpackIgnore: true */
      'https://cdn.skypack.dev/@novnc/novnc@1.6.0'
    )

    // Extract RFB from the module
    const RFB = novncModule.default?.RFB || novncModule.RFB || novncModule.default

    if (!RFB) {
      console.error('[VNC] Module structure:', Object.keys(novncModule))
      throw new Error('RFB class not found in noVNC module')
    }

    // Cache it globally
    window.noVNC = window.noVNC || {}
    window.noVNC.RFB = RFB

    return RFB
  } catch (error) {
    console.error('[VNC] Failed to load noVNC RFB:', error)
    throw new Error('Failed to load VNC library')
  }
}
