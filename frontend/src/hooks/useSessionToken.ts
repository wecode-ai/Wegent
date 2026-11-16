// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useSyncExternalStore } from 'react'
import { getSessionTokenSnapshot, SESSION_TOKEN_CHANGED_EVENT } from '@/apis/user'

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (
      (event.key === 'auth_token' || event.key === null) &&
      (!event.storageArea || event.storageArea === window.localStorage)
    ) {
      onChange()
    }
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener(SESSION_TOKEN_CHANGED_EVENT, onChange)
  window.addEventListener('focus', onChange)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(SESSION_TOKEN_CHANGED_EVENT, onChange)
    window.removeEventListener('focus', onChange)
  }
}

const getServerSnapshot = () => null

export function useSessionToken(): string | null {
  return useSyncExternalStore(subscribe, getSessionTokenSnapshot, getServerSnapshot)
}
