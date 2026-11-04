// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import client from '@/apis/client'
import { useUser } from '@/features/common/UserContext'
import { listGroups } from '@/apis/groups'
import { buildNamespaceRoleMap, type NamespaceRoleMap } from '@/utils/namespace-permissions'

let cachedScope: string | null = null
let cachedNamespaceRoleMap: NamespaceRoleMap | null = null
let pendingNamespaceRoleMapRequest: Promise<NamespaceRoleMap> | null = null
let namespaceRoleMapCacheVersion = 0

function fetchNamespaceRoleMap(scope: string): Promise<NamespaceRoleMap> {
  if (cachedScope !== scope) {
    clearNamespaceRoleMapCache()
    cachedScope = scope
  }
  if (cachedNamespaceRoleMap) {
    return Promise.resolve(cachedNamespaceRoleMap)
  }

  if (!pendingNamespaceRoleMapRequest) {
    const requestVersion = namespaceRoleMapCacheVersion
    const request = listGroups()
      .then(response => {
        const roleMap = buildNamespaceRoleMap(response.items || [])

        if (requestVersion !== namespaceRoleMapCacheVersion) {
          if (pendingNamespaceRoleMapRequest === request) {
            pendingNamespaceRoleMapRequest = null
          }
          return cachedScope === scope ? fetchNamespaceRoleMap(scope) : new Map()
        }

        cachedNamespaceRoleMap = roleMap
        return roleMap
      })
      .catch(error => {
        if (pendingNamespaceRoleMapRequest === request) {
          pendingNamespaceRoleMapRequest = null
        }
        throw error
      })
      .finally(() => {
        if (pendingNamespaceRoleMapRequest === request) {
          pendingNamespaceRoleMapRequest = null
        }
      })
    pendingNamespaceRoleMapRequest = request
  }

  return pendingNamespaceRoleMapRequest
}

export function clearNamespaceRoleMapCache() {
  namespaceRoleMapCacheVersion += 1
  cachedNamespaceRoleMap = null
  pendingNamespaceRoleMapRequest = null
}

export function useNamespaceRoleMap(): NamespaceRoleMap {
  const { user } = useUser()
  const scope = JSON.stringify([user?.id, client.getCacheScope()])
  const [stateScope, setStateScope] = useState(scope)
  const [namespaceRoleMap, setNamespaceRoleMap] = useState<NamespaceRoleMap>(new Map())

  if (stateScope !== scope) {
    setStateScope(scope)
    setNamespaceRoleMap(new Map())
  }
  useEffect(() => {
    let isActive = true

    fetchNamespaceRoleMap(scope)
      .then(roleMap => {
        if (!isActive) {
          return
        }

        setNamespaceRoleMap(roleMap)
      })
      .catch(error => {
        console.error('Failed to load groups for namespace role map:', error)
      })

    return () => {
      isActive = false
    }
  }, [scope])

  return namespaceRoleMap
}
