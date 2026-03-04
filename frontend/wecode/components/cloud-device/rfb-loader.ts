// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side noVNC RFB loader
 *
 * Loads the pre-built noVNC bundle (public/novnc/rfb.min.js) via <script> tag
 * at runtime. This avoids webpack trying to bundle noVNC, which ships CJS
 * with top-level await — a combination incompatible with webpack's module system.
 *
 * The bundle exposes `window.noVNC` as the RFB constructor.
 * Built by: scripts/build-novnc.js
 */

'use client'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let RFBCache: any = null

/**
 * Extract the RFB constructor from the loaded noVNC module.
 * The bundle may expose it directly or as {default: RFB, __esModule: true}.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractRFB(mod: any): any {
  if (!mod) return null
  // If it's a CJS-style module with __esModule flag, use .default
  if (mod.__esModule && mod.default) return mod.default
  // If it's already a constructor function, use it directly
  if (typeof mod === 'function') return mod
  // Fallback: try .default anyway
  return mod.default || mod
}

/**
 * Load the noVNC RFB class via pre-built bundle.
 *
 * @returns Promise<RFB constructor>
 */
export async function loadRFB() {
  if (RFBCache) {
    return RFBCache
  }

  // Check if already loaded (e.g., from a previous call that completed while we waited)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existing = extractRFB((window as any).noVNC)
  if (existing) {
    RFBCache = existing
    return RFBCache
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = '/novnc/rfb.min.js'
    script.async = true

    script.onload = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const RFB = extractRFB((window as any).noVNC)
      if (RFB) {
        RFBCache = RFB
        resolve(RFB)
      } else {
        reject(new Error('noVNC bundle loaded but window.noVNC is not defined'))
      }
    }

    script.onerror = () => {
      reject(new Error('Failed to load noVNC bundle from /novnc/rfb.min.js'))
    }

    document.head.appendChild(script)
  })
}
