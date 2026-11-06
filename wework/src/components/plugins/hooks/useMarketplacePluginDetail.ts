import { useEffect, useMemo, useRef, useState } from 'react'
import type { InstalledPlugin } from '@/types/api'
import type { InstalledPluginItem } from '../PluginManagementRows'
import { withMarketplacePluginDetail } from '../workspace/marketplaceWorkspaceHelpers'

/** A selection owns its entire response; never paint another plugin's detail. */
export function useMarketplacePluginDetail(options: {
  selectionKey: string
  revision: number
  base: InstalledPluginItem | null
  read?: () => Promise<InstalledPlugin>
  errorMessage: string
}) {
  const key = JSON.stringify([options.selectionKey, options.revision])
  const latest = useRef(options)
  useEffect(() => {
    latest.current = options
  })
  const [result, setResult] = useState<{
    key: string
    detail?: InstalledPlugin
    failed?: boolean
  }>({ key })
  // Retire the previous visit before painting, including A -> B -> A while B
  // is pending. The transport cache owns reuse after verifying its scope.
  if (result.key !== key) setResult({ key })
  useEffect(() => {
    const { read, selectionKey } = latest.current
    if (!selectionKey || !read) return
    let disposed = false
    void Promise.resolve()
      .then(read)
      .then(
        detail => {
          if (!disposed) setResult({ key, detail })
        },
        () => {
          if (!disposed) setResult({ key, failed: true })
        }
      )
    return () => {
      disposed = true
    }
  }, [key])
  const current = result.key === key ? result : null
  const detail = useMemo(
    () =>
      options.base && current?.detail
        ? withMarketplacePluginDetail(options.base, current.detail)
        : options.base,
    [options.base, current]
  )
  return {
    detail,
    loading: Boolean(options.selectionKey && options.read && !current?.detail && !current?.failed),
    error: current?.failed ? options.errorMessage : null,
  }
}
