// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react'

/** Keep the draft mounted while refreshing locations after a management-tab visit. */
export function useCreationLocationRefresh(open: boolean, onRefresh?: () => Promise<void>) {
  const pendingReturn = useRef(false)
  const revision = useRef(0)
  const [refreshing, setRefreshing] = useState(false)
  const [failed, setFailed] = useState(false)
  const invalidate = useCallback(() => {
    revision.current++
  }, [])
  const refresh = useCallback(async () => {
    const request = ++revision.current
    setRefreshing(true)
    setFailed(false)
    try {
      await onRefresh?.()
    } catch {
      if (request === revision.current) setFailed(true)
    } finally {
      if (request === revision.current) setRefreshing(false)
    }
  }, [onRefresh])

  const refreshPending = useCallback(() => {
    if (!pendingReturn.current) return
    pendingReturn.current = false
    void refresh()
  }, [refresh])

  useEffect(() => {
    pendingReturn.current = false
    setFailed(false)
    setRefreshing(false)
    if (!open) return
    const returned = () => {
      if (document.visibilityState !== 'hidden') refreshPending()
    }
    window.addEventListener('focus', returned)
    document.addEventListener('visibilitychange', returned)
    return () => {
      invalidate()
      window.removeEventListener('focus', returned)
      document.removeEventListener('visibilitychange', returned)
    }
  }, [open, refreshPending, invalidate])

  return {
    refreshing,
    failed,
    retry: refresh,
    onReturnInteraction: refreshPending,
    onManage: () => {
      pendingReturn.current = true
      setRefreshing(true)
    },
  }
}
