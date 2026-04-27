// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface PublishedApp {
  app_name: string
  username: string
  namespace: string
  env: string
  pod_name: string
  pod_ip: string
  host_ip: string
  node_name: string
  status: string
  ready: boolean
  restarts: number
  app_url: string
  admin_port: string
  is_online: boolean
  created_at: number
  expires_at: number
  last_check_at: number
}

export interface PublishedAppsData {
  total: number
  page: number
  page_size: number
  apps: PublishedApp[]
}

interface PublishedAppsResponse {
  code: number
  message: string
  data?: PublishedAppsData
}

const EMPTY_PUBLISHED_APPS: PublishedAppsData = {
  total: 0,
  page: 1,
  page_size: 20,
  apps: [],
}

export async function listPublishedApps(username: string): Promise<PublishedAppsData> {
  const response = await fetch(`/api/published-apps?username=${encodeURIComponent(username)}`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
    },
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || 'Failed to load published apps')
  }

  const payload = (await response.json()) as PublishedAppsResponse
  if (payload.code !== 0) {
    throw new Error(payload.message || 'Failed to load published apps')
  }

  return payload.data || EMPTY_PUBLISHED_APPS
}
