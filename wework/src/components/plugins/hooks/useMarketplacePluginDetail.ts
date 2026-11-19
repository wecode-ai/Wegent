import { useMemo, useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import type { InstalledPlugin } from '@/types/api'
import type { InstalledPluginItem } from '../PluginManagementRows'
import { withMarketplacePluginDetail } from '../workspace/marketplaceWorkspaceHelpers'
import { useStableEvent } from '@/features/workbench/useStableEvent'

/** A selection owns its entire response; never paint another plugin's detail. */
export function useMarketplacePluginDetail(options: {
  selectionKey: string
  revision: number
  base: InstalledPluginItem | null
  read?: () => Promise<InstalledPlugin>
  errorMessage: string
}) {
  const key = JSON.stringify([options.selectionKey, options.revision])
  const enabled = Boolean(options.selectionKey && options.read)
  const read = useStableEvent(() => options.read!())
  const resource = useMemo(
    () => (enabled ? createAsyncResource(key, read) : null),
    [key, enabled, read]
  )
  const result = useSyncExternalStore(
    resource?.subscribe ?? subscribeIdleResource,
    resource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  const detail = useMemo(
    () =>
      options.base && result.data
        ? withMarketplacePluginDetail(options.base, result.data)
        : options.base,
    [options.base, result.data]
  )
  return {
    detail,
    loading: enabled && result.status !== 'ready' && result.status !== 'error',
    error: result.status === 'error' ? options.errorMessage : null,
  }
}
