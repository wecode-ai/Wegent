// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime Configuration API
 *
 * This endpoint provides runtime configuration values that can be changed
 * without rebuilding the application. Environment variables are read at
 * server startup time, not build time.
 *
 * Usage:
 * - Set RUNTIME_API_URL environment variable for backend API URL
 * - Set RUNTIME_SOCKET_DIRECT_URL environment variable for Socket.IO direct URL
 * - The frontend will fetch this config on initialization
 */

import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    // Backend API URL - can be changed at runtime
    // Priority: RUNTIME_API_URL > NEXT_PUBLIC_API_URL > '/api' (use proxy)
    // Note: Empty string means use relative path '/api' through Next.js proxy
    apiUrl: process.env.RUNTIME_API_URL || process.env.NEXT_PUBLIC_API_URL || '',

    // Socket.IO direct URL - can be changed at runtime
    // Priority: RUNTIME_SOCKET_DIRECT_URL > NEXT_PUBLIC_SOCKET_DIRECT_URL > empty
    // Note: Empty string means use relative path through Next.js proxy
    socketDirectUrl:
      process.env.RUNTIME_SOCKET_DIRECT_URL || process.env.NEXT_PUBLIC_SOCKET_DIRECT_URL || '',
  });
}
