// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Streaming chat API route
 *
 * Proxies SSE (Server-Sent Events) from backend to frontend.
 * This is required because Next.js rewrites don't support streaming.
 */

import { NextRequest } from 'next/server'
import { createStreamProxy } from '@/lib/stream-proxy'

/**
 * POST /api/chat/stream
 *
 * Proxies streaming chat requests to the backend API.
 * The backend will respond with Server-Sent Events (SSE).
 *
 * @param request - The incoming request with chat parameters
 * @returns A streaming response with SSE data
 */
export async function POST(request: NextRequest): Promise<Response> {
  return createStreamProxy(request, '/api/chat/stream')
}
