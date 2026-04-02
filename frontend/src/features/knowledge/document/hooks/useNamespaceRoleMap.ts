// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { listGroups } from '@/apis/groups'
import { buildNamespaceRoleMap, type NamespaceRoleMap } from '@/utils/namespace-permissions'

let cachedNamespaceRoleMap: NamespaceRoleMap | null = null
let pendingNamespaceRoleMapRequest: Promise<NamespaceRoleMap> | null = null

function fetchNamespaceRoleMap(): Promise<NamespaceRoleMap> {
  if (cachedNamespaceRoleMap) {
    return Promise.resolve(cachedNamespaceRoleMap)
  }

  if (!pendingNamespaceRoleMapRequest) {
    pendingNamespaceRoleMapRequest = listGroups()
      .then(response => {
        const roleMap = buildNamespaceRoleMap(response.items || [])
        cachedNamespaceRoleMap = roleMap
        return roleMap
      })
      .catch(error => {
        pendingNamespaceRoleMapRequest = null
        throw error
      })
      .finally(() => {
        pendingNamespaceRoleMapRequest = null
      })
  }

  return pendingNamespaceRoleMapRequest
}

export function clearNamespaceRoleMapCache() {
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
