// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Next.js API Route for getting streaming content.
 *
 * This route proxies requests to the backend to get streaming content
 * for recovery when user refreshes during streaming.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getInternalApiUrl } from '@/lib/server-config'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subtaskId: string }> }
) {
  try {
    const { subtaskId } = await params

    // Get authorization header
    const authHeader = request.headers.get('Authorization')

    // Forward request to backend
    const backendResponse = await fetch(
      `${getInternalApiUrl()}/api/chat/streaming-content/${subtaskId}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(authHeader && { Authorization: authHeader }),
        },
      }
    )

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
    console.error('Streaming content proxy error:', error)
    return NextResponse.json({ error: 'Failed to get streaming content' }, { status: 500 })
  }
}
