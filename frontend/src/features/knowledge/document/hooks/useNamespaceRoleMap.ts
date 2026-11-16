// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import client from '@/apis/client'
import { useUser } from '@/features/common/UserContext'
import { listGroups } from '@/apis/groups'
import type { Group } from '@/types/group'
import { buildNamespaceRoleMap, type NamespaceRoleMap } from '@/utils/namespace-permissions'

interface NamespaceRoles {
  roleMap: NamespaceRoleMap
  groups: Group[]
}
let cachedScope: string | null = null
let cachedRoles: NamespaceRoles | null = null
let pendingRequest: Promise<NamespaceRoles> | null = null
let cacheVersion = 0

async function loadNamespaceRoles(): Promise<NamespaceRoles> {
  const groups: Group[] = []
  for (let page = 1; ; page++) {
    const response = await listGroups({ page, limit: 100 })
    groups.push(...response.items)
    if (groups.length >= response.total || response.items.length < 100) {
      return { roleMap: buildNamespaceRoleMap(groups), groups }
    }
  }
}

function fetchNamespaceRoles(scope: string): Promise<NamespaceRoles> {
  if (cachedScope !== scope) {
    clearNamespaceRoleMapCache()
    cachedScope = scope
  }
  if (cachedRoles) return Promise.resolve(cachedRoles)
  if (!pendingRequest) {
    const version = cacheVersion
    const request = loadNamespaceRoles()
      .then(roles => {
        if (version !== cacheVersion) {
          if (pendingRequest === request) pendingRequest = null
          return cachedScope === scope
            ? fetchNamespaceRoles(scope)
            : { roleMap: new Map(), groups: [] }
        }
        cachedRoles = roles
        return roles
      })
      .finally(() => {
        if (pendingRequest === request) pendingRequest = null
      })
    pendingRequest = request
  }
  return pendingRequest
}

export function clearNamespaceRoleMapCache() {
  cacheVersion++
  cachedRoles = null
  pendingRequest = null
}

export function useNamespaceRoleState() {
  const { user } = useUser()
  const scope = JSON.stringify([user?.id, client.getCacheScope()])
  const scopeRef = useRef(scope)
  const revision = useRef(0)
  scopeRef.current = scope
  const [state, setState] = useState({
    scope,
    roleMap: new Map() as NamespaceRoleMap,
    groups: [] as Group[],
    loading: true,
    failed: false,
  })
  const load = useCallback(
    async (invalidate: boolean) => {
      if (scopeRef.current !== scope) return
      if (invalidate) clearNamespaceRoleMapCache()
      const request = ++revision.current
      const current = () => scopeRef.current === scope && revision.current === request
      setState(previous => ({
        ...(previous.scope === scope ? previous : { roleMap: new Map(), groups: [] }),
        scope,
        loading: true,
        failed: false,
      }))
      try {
        const roles = await fetchNamespaceRoles(scope)
        if (current()) setState({ ...roles, scope, loading: false, failed: false })
      } catch (error) {
        if (current()) setState(previous => ({ ...previous, scope, loading: false, failed: true }))
        throw error
      }
    },
    [scope]
  )
  const refresh = useCallback(() => load(true), [load])
  useEffect(() => {
    void load(false).catch(() => undefined)
    return () => {
      revision.current++
    }
  }, [load])
  const scopedState =
    state.scope === scope
      ? state
      : {
          scope,
          roleMap: new Map() as NamespaceRoleMap,
          groups: [] as Group[],
          loading: true,
          failed: false,
        }
  return { ...scopedState, refresh }
}

export function useNamespaceRoleMap(): NamespaceRoleMap {
  return useNamespaceRoleState().roleMap
}
