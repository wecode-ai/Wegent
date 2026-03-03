// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side noVNC RFB loader
 *
 * Uses script tag injection to load noVNC from CDN,
 * completely bypassing Webpack/Turbopack module resolution issues.
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

const NOVNC_CDN_URL = 'https://cdn.jsdelivr.net/npm/@novnc/novnc@1.6.0/lib/rfb.min.js'

/**
 * Dynamically load a script by URL
 */
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Check if already loaded
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve()
      return
    }

    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`))
    document.head.appendChild(script)
  })
}

/**
 * Load the noVNC RFB class.
 * This function can be called multiple times - it caches the result after first load.
 *
 * @returns Promise<RFB constructor>
 */
export async function loadRFB() {
  // Check if already loaded globally
  if (typeof window !== 'undefined' && window.noVNC?.RFB) {
    return window.noVNC.RFB
  }
  if (typeof window !== 'undefined' && window.RFB) {
    return window.RFB
  }

  try {
    // Load from CDN
    await loadScript(NOVNC_CDN_URL)

    // Wait a tick for the script to initialize
    await new Promise(resolve => setTimeout(resolve, 100))

    // Check for global RFB object - try multiple locations
    const RFB =
      window.noVNC?.RFB ||
      window.RFB ||
      (window as Window & { noVnc?: { RFB: unknown } }).noVnc?.RFB
    if (!RFB) {
      console.error(
        '[VNC] Available globals:',
        Object.keys(window).filter(
          k => k.toLowerCase().includes('rfb') || k.toLowerCase().includes('novnc')
        )
      )
      throw new Error('RFB class not found after loading noVNC')
    }

    return RFB
  } catch (error) {
    console.error('[VNC] Failed to load noVNC RFB:', error)
    throw new Error('Failed to load VNC library')
  }
}
