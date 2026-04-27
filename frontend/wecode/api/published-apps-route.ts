// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server'

const DEFAULT_PUBLISHED_APPS_API_URL = 'http://10.37.255.188:3001'

function isSameOriginRequest(request: NextRequest): boolean {
  const secFetchSite = request.headers.get('sec-fetch-site')
  if (secFetchSite === 'same-origin') {
    return true
  }

  const referer = request.headers.get('referer')
  if (!referer) {
    return false
  }

  try {
    const refererUrl = new URL(referer)
    return refererUrl.host === (request.headers.get('host') || '')
  } catch {
    return false
  }
}

function getServiceAuthorization(): string {
  const token =
    process.env.RUNTIME_PUBLISHED_APPS_API_TOKEN || process.env.PUBLISHED_APPS_API_TOKEN || ''
  return token ? `Bearer ${token}` : ''
}

function getServiceBaseUrl(): string {
  return (
    process.env.RUNTIME_PUBLISHED_APPS_API_URL ||
    process.env.PUBLISHED_APPS_API_URL ||
    DEFAULT_PUBLISHED_APPS_API_URL
  ).replace(/\/+$/, '')
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 })
  }

  const username = request.nextUrl.searchParams.get('username')?.trim()
  if (!username) {
    return NextResponse.json({ error: 'username is required' }, { status: 400 })
  }

  const authorization = getServiceAuthorization()
  if (!authorization) {
    return NextResponse.json(
      { error: 'Published apps service authorization is not configured' },
      { status: 401 }
    )
  }

  const targetUrl = new URL('/app/list', getServiceBaseUrl())
  targetUrl.searchParams.set('username', username)

  try {
    const response = await fetch(targetUrl.toString(), {
      method: 'GET',
      headers: new Headers({
        accept: 'application/json',
        Authorization: authorization,
        'Content-Type': 'application/json',
      }),
    })

    const body = await response.text()
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json; charset=utf-8',
      },
    })
  } catch (error) {
    console.error('[PublishedApps] Failed to fetch published apps:', error)
    return NextResponse.json({ error: 'Failed to fetch published apps' }, { status: 502 })
  }
}
