// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { NextResponse } from 'next/server'

import { appleAppSiteAssociation } from '@/lib/app-link-association'

export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json(
    appleAppSiteAssociation(
      process.env.WEWORK_IOS_APP_LINK_TEAM_ID,
      process.env.WEWORK_IOS_APP_LINK_BUNDLE_ID
    ),
    {
      headers: {
        'Cache-Control': 'public, max-age=300',
        'Content-Type': 'application/json',
      },
    }
  )
}
