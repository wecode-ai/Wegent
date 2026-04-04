// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { listGroups } from '@/apis/groups'
import { buildNamespaceRoleMap, type NamespaceRoleMap } from '@/utils/namespace-permissions'

let cachedNamespaceRoleMap: NamespaceRoleMap | null = null
let pendingNamespaceRoleMapRequest: Promise<NamespaceRoleMap> | null = null
let namespaceRoleMapCacheVersion = 0

function fetchNamespaceRoleMap(): Promise<NamespaceRoleMap> {
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
          return fetchNamespaceRoleMap()
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
  const [namespaceRoleMap, setNamespaceRoleMap] = useState<NamespaceRoleMap>(new Map())

  useEffect(() => {
    let isActive = true

    fetchNamespaceRoleMap()
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
  }, [])

  return namespaceRoleMap
}
