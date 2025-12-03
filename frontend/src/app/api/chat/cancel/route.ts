// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Next.js API Route for cancelling chat stream.
 *
 * This route proxies cancel requests to the backend.
 */

import { NextRequest, NextResponse } from 'next/server';

// Get backend URL from environment
const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export async function POST(request: NextRequest) {
  try {
    // Get the request body
    const body = await request.json();

    console.log('[CANCEL_DEBUG] Cancel request received:', {
      subtask_id: body.subtask_id,
      partial_content_len: body.partial_content?.length || 0,
    });

    // Get authorization header
    const authHeader = request.headers.get('Authorization');

    // Forward request to backend
    console.log(
      '[CANCEL_DEBUG] Forwarding cancel request to backend:',
      `${BACKEND_URL}/api/chat/cancel`
    );
    const backendResponse = await fetch(`${BACKEND_URL}/api/chat/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authHeader && { Authorization: authHeader }),
      },
      body: JSON.stringify(body),
    });

    if (!backendResponse.ok) {
      const errorText = await backendResponse.text();
      console.error(
        '[CANCEL_DEBUG] Backend cancel request failed:',
        backendResponse.status,
        errorText
      );
      return new NextResponse(errorText, {
        status: backendResponse.status,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    }

    const data = await backendResponse.json();
    console.log('[CANCEL_DEBUG] Backend cancel response:', data);
    return NextResponse.json(data);
  } catch (error) {
    console.error('[CANCEL_DEBUG] Chat cancel proxy error:', error);
    return NextResponse.json({ error: 'Failed to proxy chat cancel request' }, { status: 500 });
  }
}
