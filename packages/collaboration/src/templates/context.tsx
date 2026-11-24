// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext, useCallback, useSyncExternalStore } from 'react'
import type { CollaborationTemplateStore } from './store'

export const CollaborationTemplateContext = createContext<CollaborationTemplateStore | null>(null)
export const useCollaborationTemplateStore = () => useContext(CollaborationTemplateContext)

export function useTemplateRecords(store: CollaborationTemplateStore) {
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribe = store.subscribe(listener)
      void store
        .load()
        .then(() => store.synchronize())
        .catch(() => undefined)
      return unsubscribe
    },
    [store]
  )
  return useSyncExternalStore(subscribe, store.getSnapshot, store.getSnapshot)
}
