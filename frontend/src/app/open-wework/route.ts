// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { NextResponse, type NextRequest } from 'next/server'

import { parseWeworkHandoff } from './handoff'
import { renderWeworkHandoffPage } from './handoffPage'

export const dynamic = 'force-dynamic'

export function GET(request: NextRequest) {
  const html = renderWeworkHandoffPage({
    acceptLanguage: request.headers.get('accept-language') ?? '',
    destination: parseWeworkHandoff(request.nextUrl.searchParams),
    userAgent: request.headers.get('user-agent') ?? '',
  })
  return new NextResponse(html, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
      'X-Frame-Options': 'DENY',
    },
  })
}
