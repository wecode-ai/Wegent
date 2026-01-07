// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * OTLP Traces Proxy API Route
 *
 * Proxies OpenTelemetry trace data from browser to OTEL Collector.
 * This avoids CORS issues since browser sends to same origin.
 *
 * The browser sends traces to /otlp/traces (same domain),
 * and this route forwards them to the internal OTEL Collector.
 *
 * NOTE: This route uses /otlp prefix (not /api/otlp) to avoid
 * conflict with the /api/* rewrite rule in next.config.js that
 * proxies all /api/* requests to the backend.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getRuntimeConfigSync } from '@/lib/runtime-config'

/**
 * Get OTEL Collector endpoint from runtime config
 */
const getOtelCollectorEndpoint = (): string => {
  return getRuntimeConfigSync().otelCollectorEndpoint
}

/**
 * POST /otlp/traces
 *
 * Proxies OTLP trace data to the OpenTelemetry Collector.
 * Supports both JSON and Protobuf content types.
 *
 * @param request - The incoming request with OTLP trace data
 * @returns Success response or error
 */
export async function POST(request: NextRequest): Promise<Response> {
  // Check if telemetry is enabled via runtime config
  const runtimeConfig = getRuntimeConfigSync()
  if (!runtimeConfig.otelEnabled) {
    return NextResponse.json({ message: 'Telemetry is disabled' }, { status: 200 })
  }

  try {
    // Get the raw body as ArrayBuffer to preserve binary data (protobuf)
    const body = await request.arrayBuffer()

    // Preserve the content type from the original request
    const contentType = request.headers.get('content-type') || 'application/json'

    // Get OTEL Collector endpoint from runtime config
    const collectorEndpoint = getOtelCollectorEndpoint()

    // Forward the request to OTEL Collector
    const response = await fetch(`${collectorEndpoint}/v1/traces`, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
      },
      body: body,
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[OTLP Proxy] Collector error: ${response.status} - ${errorText}`)
      return NextResponse.json(
        { error: 'Failed to send traces to collector' },
        { status: response.status }
      )
    }

    // Return success
    return NextResponse.json({ success: true }, { status: 200 })
  } catch (error) {
    // Log the error but don't expose internal details
    console.error('[OTLP Proxy] Error forwarding traces:', error)

    // Return a generic error response
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * OPTIONS /otlp/traces
 *
 * Handle CORS preflight requests (though not needed for same-origin).
 * Included for completeness.
 */
export async function OPTIONS(): Promise<Response> {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  })
}
