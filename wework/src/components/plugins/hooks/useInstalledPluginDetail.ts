import { useEffect, useMemo, useRef, useState } from 'react'
import type { InstalledPlugin } from '@/types/api'
import type { InstalledPluginItem } from '../PluginManagementRows'

/** Keep resolved components when background inventory refreshes return summaries. */
export function useInstalledPluginDetail(
  summary: InstalledPluginItem | null,
  read: (plugin: InstalledPlugin) => Promise<InstalledPlugin>,
  onError: (pluginId: string | number, error: unknown) => void
): InstalledPluginItem | null {
  const [detail, setDetail] = useState<{
    key: string
    components: InstalledPlugin['spec']['components']
  } | null>(null)
  const refs = useRef({ summary, onError })
  useEffect(() => {
    refs.current = { summary, onError }
  }, [summary, onError])
  const local = summary && (summary.origin === 'created' || !summary.raw.spec.pluginId)
  const key = local ? JSON.stringify([summary.id, summary.version]) : null
  useEffect(() => {
    const plugin = refs.current.summary
    if (!key || !plugin) return
    let disposed = false
    void read(plugin.raw)
      .then(result => {
        if (!disposed) setDetail({ key, components: result.spec.components })
      })
      .catch(error => {
        if (!disposed) refs.current.onError(plugin.id, error)
      })
    return () => {
      disposed = true
    }
  }, [key, read])
  return useMemo(() => {
    if (!summary || !detail || detail.key !== key) return summary
    return {
      ...summary,
      raw: { ...summary.raw, spec: { ...summary.raw.spec, components: detail.components } },
    }
  }, [summary, detail, key])
}
