// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import apiClient from '@/apis/client'

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

const EMPTY_PUBLISHED_APPS: PublishedAppsData = {
  total: 0,
  page: 1,
  page_size: 20,
  apps: [],
}

export async function listPublishedApps(): Promise<PublishedAppsData> {
  const payload = await apiClient.get<PublishedAppsResponse>('/published-apps')
  if (payload.code !== 0) {
    throw new Error(payload.message || 'Failed to load published apps')
  }
  return payload.data || EMPTY_PUBLISHED_APPS
}

export async function deletePublishedApp(appName: string): Promise<PublishedAppsMutationResponse> {
  const payload = await apiClient.delete<PublishedAppsMutationResponse>(
    `/published-apps/${encodeURIComponent(appName)}`
  )
  if (payload.code !== 0) {
    throw new Error(payload.message || 'Failed to delete published app')
  }
  return payload
}

export async function listAllPublishedApps(): Promise<PublishedAppsData> {
  const payload = await apiClient.get<PublishedAppsResponse>('/admin/published-apps')
  if (payload.code !== 0) {
    throw new Error(payload.message || 'Failed to load published apps')
  }
  return payload.data || EMPTY_PUBLISHED_APPS
}

export async function deletePublishedAppAdmin(
  appName: string,
  username: string
): Promise<PublishedAppsMutationResponse> {
  const params = new URLSearchParams({ username })
  const payload = await apiClient.delete<PublishedAppsMutationResponse>(
    `/admin/published-apps/${encodeURIComponent(appName)}?${params}`
  )
  if (payload.code !== 0) {
    throw new Error(payload.message || 'Failed to delete published app')
  }
  return payload
}
