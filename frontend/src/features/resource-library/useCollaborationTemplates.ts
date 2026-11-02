// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import apiClient from '@/apis/client'
import { useUser } from '@/features/common/UserContext'
import { getApiBaseUrl } from '@/lib/runtime-config'
import {
  browserTemplatePersistence,
  CollaborationTemplateStore,
  createCollaborationTemplateRemote,
} from '@wegent/collaboration/templates'

const stores = new Map<string, CollaborationTemplateStore>()

export function useCollaborationTemplates() {
  const { user } = useUser()
  const ownerId = user?.id
  const backend = getApiBaseUrl()
  const authScope = apiClient.getCacheScope()
  const scope = `${backend}:${ownerId ?? 'anonymous'}`
  const [store, setStore] = useState<CollaborationTemplateStore | null>(null)
  useEffect(() => {
    if (!ownerId) {
      setStore(null)
      return
    }
    const key = `${scope}:${authScope}`
    let scoped = stores.get(key)
    if (!scoped) {
      const requireScope = () => {
        if (apiClient.getCacheScope() !== authScope || getApiBaseUrl() !== backend)
          throw new Error('Template account scope changed')
      }
      const remote = createCollaborationTemplateRemote({
        get<T>(path: string) {
          requireScope()
          return apiClient.get<T>(path)
        },
        post<T>(path: string, body?: unknown) {
          requireScope()
          return apiClient.post<T>(path, body)
        },
        put<T>(path: string, body?: unknown) {
          requireScope()
          return apiClient.put<T>(path, body)
        },
      })
      scoped = new CollaborationTemplateStore({
        scope,
        ownerId,
        remote,
        persistence: browserTemplatePersistence(scope, window.localStorage),
      })
      stores.set(key, scoped)
    }
    setStore(scoped)
  }, [scope, ownerId, backend, authScope])
  return store?.library.scope === scope ? store : null
}
