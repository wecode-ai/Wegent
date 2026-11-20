import { useMemo, useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { useStableEvent } from '@/features/workbench/useStableEvent'
import type { InstalledPlugin } from '@/types/api'
import type { InstalledPluginItem } from '../PluginManagementRows'

/** Keep resolved components when background inventory refreshes return summaries. */
export function useInstalledPluginDetail(
  summary: InstalledPluginItem | null,
  read: (plugin: InstalledPlugin) => Promise<InstalledPlugin>,
  onError: (pluginId: string | number, error: unknown) => void,
  revision = 0,
  onSuccess?: (pluginId: string | number) => void
): InstalledPluginItem | null {
  const local = summary && (summary.origin === 'created' || !summary.raw.spec.pluginId)
  const key = local ? JSON.stringify([summary.id, summary.version, revision]) : null
  const currentSummary = useStableEvent(() => summary!)
  const pluginId = summary?.id
  const success = useStableEvent((id: string | number) => onSuccess?.(id))
  const failure = useStableEvent((id: string | number, error: unknown) => onError(id, error))
  const resource = useMemo(
    () =>
      key
        ? createAsyncResource(key, () => read(currentSummary().raw), {
            success: () => success(pluginId!),
            failure: error => failure(pluginId!, error),
          })
        : null,
    [key, pluginId, read, currentSummary, success, failure]
  )
  const result = useSyncExternalStore(
    resource?.subscribe ?? subscribeIdleResource,
    resource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  return useMemo(() => {
    if (!summary || !result.data) return summary
    return {
      ...summary,
      raw: {
        ...summary.raw,
        spec: { ...summary.raw.spec, components: result.data.spec.components },
      },
    }
  }, [summary, result.data])
}
