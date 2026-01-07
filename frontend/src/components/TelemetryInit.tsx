// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * TelemetryInit Component
 *
 * Client-side component that initializes OpenTelemetry tracing.
 * This component should be placed in the root layout to ensure
 * telemetry is initialized early in the application lifecycle.
 *
 * Features:
 * - Initializes only in browser environment
 * - Prevents double initialization
 * - Gracefully handles initialization errors
 * - Configurable via runtime environment variables
 */

import { useEffect, useRef } from 'react'
import { getRuntimeConfigSync } from '@/lib/runtime-config'

/**
 * TelemetryInit initializes OpenTelemetry for browser-side tracing.
 *
 * It tracks:
 * - User interactions (button clicks, form submits)
 * - Fetch API requests
 * - Document load performance
 *
 * Configuration is done via runtime environment variables:
 * - RUNTIME_OTEL_ENABLED: Enable/disable telemetry (default: false)
 * - RUNTIME_OTEL_SERVICE_NAME: Service name (default: wegent-frontend)
 *
 * @returns null - This component doesn't render anything
 *
 * @example
 * ```tsx
 * // In your root layout
 * <TelemetryInit />
 * ```
 */
export default function TelemetryInit(): null {
  const initRef = useRef(false)

  useEffect(() => {
    // Only run in browser environment
    if (typeof window === 'undefined') {
      return
    }

    // Prevent double initialization
    if (initRef.current) {
      return
    }
    initRef.current = true

    // Check if telemetry is enabled via runtime config
    const runtimeConfig = getRuntimeConfigSync()
    if (!runtimeConfig.otelEnabled) {
      return
    }

    // Dynamically import and initialize the tracer
    // This keeps the bundle size small when telemetry is disabled
    import('@/lib/telemetry')
      .then(module => {
        return module.initFrontendTracer()
      })
      .catch(error => {
        // Log error but don't crash the app
        console.error('[TelemetryInit] Failed to initialize telemetry:', error)
      })
  }, [])

  // This component doesn't render anything
  return null
}
