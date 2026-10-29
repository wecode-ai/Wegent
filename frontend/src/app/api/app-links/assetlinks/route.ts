// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { NextResponse } from 'next/server'

import { androidAssetLinks } from '@/lib/app-link-association'

export const dynamic = 'force-dynamic'

export function GET() {
  const links = androidAssetLinks(process.env.WEWORK_ANDROID_APP_LINK_SHA256)
  if (links.length === 0) return new NextResponse(null, { status: 404 })

  return NextResponse.json(links, {
    headers: {
      'Cache-Control': 'public, max-age=300',
      'Content-Type': 'application/json',
    },
  })
}
