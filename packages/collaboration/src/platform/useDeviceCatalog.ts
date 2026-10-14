// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef } from 'react'

import { useExecutionEnvironmentList } from '../execution-environment/useExecutionEnvironmentList'
import { compareExecutionEnvironments } from '../execution-environment/compareExecutionEnvironments'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationExecutionEnvironment } from '../types'

export function useDeviceCatalog(
  api: SharedWorkspaceApi,
  enabled: boolean,
  refreshKey?: string,
  currentUser?: { id: number; name: string }
) {
  const sources = api.resources?.devices
  const local = useExecutionEnvironmentList(
    api,
    'device-local',
    '',
    enabled && Boolean(sources?.local)
  )
  const cloud = useExecutionEnvironmentList(
    api,
    'device-cloud',
    '',
    enabled && Boolean(sources?.cloud)
  )
  const active = [
    ...(sources?.local ? [{ source: 'local' as const, ...local }] : []),
    ...(sources?.cloud ? [{ source: 'cloud' as const, ...cloud }] : []),
  ]
  const refreshLocal = local.refresh
  const refreshCloud = cloud.refresh
  const refresh = useCallback(async () => {
    await Promise.all([
      ...(sources?.local ? [refreshLocal()] : []),
      ...(sources?.cloud ? [refreshCloud()] : []),
    ])
  }, [sources, refreshLocal, refreshCloud])
  const previousRefreshKey = useRef(refreshKey)
  useEffect(() => {
    const changed = previousRefreshKey.current !== refreshKey
    previousRefreshKey.current = refreshKey
    if (enabled && changed) void refresh()
  }, [enabled, refreshKey, refresh])

  // Cloud records carry the registered identity; local-only runners remain usable locally.
  const devices = new Map<string, CollaborationExecutionEnvironment>()
  const identity = (device: CollaborationExecutionEnvironment) =>
    device.app_device_id?.trim() ||
    device.device_key?.trim() ||
    `device:${device.device_id ?? device.id}`
  const localKeys = new Set((local.items ?? []).map(identity))
  for (const device of local.items ?? []) devices.set(identity(device), device)
  for (const device of cloud.items ?? []) {
    const key = identity(device)
    devices.set(key, localKeys.has(key) ? { ...device, is_current_device: true } : device)
  }
  return {
    items: [...devices.values()]
      .sort(compareExecutionEnvironments)
      .map(device =>
        device.owner_type === 'user' && !device.owner_id && currentUser
          ? { ...device, owner_id: String(currentUser.id), owner_name: currentUser.name }
          : device
      ),
    pending: active.some(source => source.loading),
    complete: active.every(source => source.items !== undefined && !source.error),
    errors: active
      .filter(source => source.error)
      .map(({ source, error, refresh }) => ({ source, error, retry: refresh })),
    refresh,
  }
}

export type DeviceCatalogState = ReturnType<typeof useDeviceCatalog>
