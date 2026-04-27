// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface PublishedApp {
  app_name: string
  task_id?: number | string | null
  taskid?: number | string | null
  taskId?: number | string | null
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

interface PublishedAppsMutationResponse {
  code: number
  message: string
}

interface ErrorResponse {
  detail?: string
  message?: string
}

const EMPTY_PUBLISHED_APPS: PublishedAppsData = {
  total: 0,
  page: 1,
  page_size: 20,
  apps: [],
}

export async function listPublishedApps(): Promise<PublishedAppsData> {
  const response = await fetch('/api/published-apps', {
    method: 'GET',
    headers: {
      accept: 'application/json',
    },
  })

  if (!response.ok) {
    const message = parseErrorMessage(await response.text())
    throw new Error(message || 'Failed to load published apps')
  }

  const payload = (await response.json()) as PublishedAppsResponse
  if (payload.code !== 0) {
    throw new Error(payload.message || 'Failed to load published apps')
  }

  return payload.data || EMPTY_PUBLISHED_APPS
}

export async function deletePublishedApp(appName: string): Promise<PublishedAppsMutationResponse> {
  const response = await fetch(`/api/published-apps/${encodeURIComponent(appName)}`, {
    method: 'DELETE',
    headers: {
      accept: 'application/json',
    },
  })

  if (!response.ok) {
    const message = parseErrorMessage(await response.text())
    throw new Error(message || 'Failed to delete published app')
  }

  const payload = (await response.json()) as PublishedAppsMutationResponse
  if (payload.code !== 0) {
    throw new Error(payload.message || 'Failed to delete published app')
  }

  return payload
}

function parseErrorMessage(body: string): string {
  if (!body) {
    return ''
  }

  try {
    const payload = JSON.parse(body) as ErrorResponse
    return payload.detail || payload.message || body
  } catch {
    return body
  }
}
