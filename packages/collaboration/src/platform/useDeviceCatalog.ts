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
  currentUser?: { id: number; name: string },
) {
  const sources = api.resources?.devices
  const local = useExecutionEnvironmentList(
    api,
    'device-local',
    '',
    enabled && Boolean(sources?.local),
  )
  const cloud = useExecutionEnvironmentList(
    api,
    'device-cloud',
    '',
    enabled && Boolean(sources?.cloud),
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
  const identity = (device: CollaborationExecutionEnvironment) =>
    device.app_device_id?.trim() ||
    device.device_key?.trim() ||
    `device:${device.device_id ?? device.id}`
  const cloudItems = cloud.items ?? []
  const localItems = [
    ...new Map(
      (local.items ?? []).map((device) => [
        `${identity(device)}\0${device.runtime_instance_id ?? ''}`,
        device,
      ]),
    ).values(),
  ]
  // A visible local placeholder does not establish the registration identity.
  const localIdentityUnresolved =
    sources?.local &&
    (localItems.length === 0 ||
      localItems.some(
        device =>
          device.local_identity_unresolved ||
          !(device.app_device_id?.trim() || device.device_key?.trim()),
      ))
  const registrationCounts = new Map<string, number>()
  for (const device of cloudItems) {
    const key = identity(device)
    registrationCounts.set(key, (registrationCounts.get(key) ?? 0) + 1)
  }
  const matchedLocal = new Set<CollaborationExecutionEnvironment>()
  const registered = cloudItems.map((device) => {
    if (localIdentityUnresolved && device.kind === 'local_device') {
      return { ...device, is_current_device_candidate: true }
    }
    const key = identity(device)
    const siblingCount = registrationCounts.get(key) ?? 0
    const candidates = localItems.filter(
      (candidate) => identity(candidate) === key,
    )
    const runtime = device.runtime_instance_id?.trim()
    const current = candidates.find((candidate) => {
      const localRuntime = candidate.runtime_instance_id?.trim()
      if (localRuntime && runtime) {
        return localRuntime === runtime
      }
      return siblingCount === 1
    })
    if (current) {
      matchedLocal.add(current)
      return { ...device, is_current_device: true }
    }
    // An app match alone cannot distinguish sibling registrations.
    if (
      siblingCount > 1 &&
      candidates.some((candidate) => !runtime || !candidate.runtime_instance_id?.trim())
    ) {
      return { ...device, is_current_device_candidate: true }
    }
    return device
  })
  const devices = [
    ...localItems.filter((device) => !matchedLocal.has(device)),
    ...registered,
  ]
  return {
    items: devices.sort(compareExecutionEnvironments).map((device) =>
      device.owner_type === 'user' && !device.owner_id && currentUser
        ? {
            ...device,
            owner_id: String(currentUser.id),
            owner_name: currentUser.name,
          }
        : device,
    ),
    pending: active.some((source) => source.loading),
    complete: active.every(
      (source) => source.items !== undefined && !source.error,
    ),
    errors: active
      .filter((source) => source.error)
      .map(({ source, error, refresh }) => ({ source, error, retry: refresh })),
    refresh,
    refreshCloud,
    remove(recordId: string) {
      const withoutRecord = (items: CollaborationExecutionEnvironment[]) =>
        items.filter((device) => device.id !== recordId)
      cloud.update(withoutRecord)
    },
  }
}

export type DeviceCatalogState = ReturnType<typeof useDeviceCatalog>
