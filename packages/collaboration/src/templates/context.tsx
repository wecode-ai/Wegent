// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext, useEffect, useSyncExternalStore } from 'react'
import type { CollaborationTemplateStore } from './store'

export const CollaborationTemplateContext = createContext<CollaborationTemplateStore | null>(null)
export const useCollaborationTemplateStore = () => useContext(CollaborationTemplateContext)

export function useTemplateRecords(store: CollaborationTemplateStore) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  useEffect(() => {
    void store
      .load()
      .then(() => store.synchronize())
      .catch(() => undefined)
  }, [store])
  return snapshot
}
