// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { listGroups } from '@/apis/groups'
import { buildNamespaceRoleMap, type NamespaceRoleMap } from '@/utils/namespace-permissions'

export function useNamespaceRoleMap(): NamespaceRoleMap {
  const [namespaceRoleMap, setNamespaceRoleMap] = useState<NamespaceRoleMap>(new Map())

  useEffect(() => {
    let isActive = true

    listGroups()
      .then(response => {
        if (!isActive) {
          return
        }

        setNamespaceRoleMap(buildNamespaceRoleMap(response.items || []))
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
