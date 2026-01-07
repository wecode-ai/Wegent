// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Next.js API Route for wizard generate-followup.
 *
 * This route manually proxies requests to the backend with extended timeout,
 * as LLM calls can take 30+ seconds which exceeds Next.js rewrite proxy limits.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getInternalApiUrl } from '@/lib/server-config'

// Extended timeout for LLM calls (60 seconds)
const TIMEOUT_MS = 60000

export async function POST(request: NextRequest) {
  try {
    // Get the request body
    const body = await request.json()

    // Get authorization header
    const authHeader = request.headers.get('Authorization')

    // Create AbortController for timeout
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
      // Forward request to backend
      const backendResponse = await fetch(`${getInternalApiUrl()}/api/wizard/generate-followup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authHeader && { Authorization: authHeader }),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!backendResponse.ok) {
        const errorText = await backendResponse.text()
        return new NextResponse(errorText, {
          status: backendResponse.status,
          headers: {
            'Content-Type': 'application/json',
          },
        })
      }

      const data = await backendResponse.json()
      return NextResponse.json(data)
    } catch (error) {
      clearTimeout(timeoutId)
      if (error instanceof Error && error.name === 'AbortError') {
        return NextResponse.json(
          { error: 'Request timeout - LLM call took too long' },
          { status: 504 }
        )
      }
      throw error
    }
  } catch (error) {
    console.error('Wizard generate-followup proxy error:', error)
    return NextResponse.json({ error: 'Failed to proxy wizard request' }, { status: 500 })
  }
}

// Set max duration for serverless function (Vercel/Edge)
export const maxDuration = 60
