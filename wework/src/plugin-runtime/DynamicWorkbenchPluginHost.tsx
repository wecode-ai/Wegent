import { useEffect } from 'react'

import { createHttpClient } from '@/api/http'
import { createPluginApi } from '@/api/plugins'
import { useCloudConnection } from '@/features/cloud-connection/useCloudConnection'

import { getWorkbenchPluginRuntime } from './bootstrap'
import {
  ExternalWorkbenchPluginLoader,
  listDeviceWorkbenchPlugins,
  type InspectedWorkbenchPlugin,
} from './external'

function filterDesiredPlugins(
  localPlugins: InspectedWorkbenchPlugin[],
  desiredNames: ReadonlySet<string> | null
) {
  if (!desiredNames) return localPlugins
  return localPlugins.filter(
    plugin => plugin.manifest.required || desiredNames.has(plugin.manifest.name)
  )
}

export function DynamicWorkbenchPluginHost() {
  const cloud = useCloudConnection()

  useEffect(() => {
    const loader = new ExternalWorkbenchPluginLoader(getWorkbenchPluginRuntime())
    let cancelled = false

    const load = async () => {
      const localPlugins = await listDeviceWorkbenchPlugins()
      let desiredNames: Set<string> | null = null
      if (cloud.isConnected && cloud.apiBaseUrl) {
        const api = createPluginApi(
          createHttpClient({
            baseUrl: cloud.apiBaseUrl,
            getToken: () => cloud.token,
            redirectOnUnauthorized: false,
          })
        )
        const installed = await api.listInstalledPlugins()
        desiredNames = new Set(
          installed.items
            .filter(
              plugin =>
                plugin.spec.enabled &&
                plugin.spec.installState !== 'uninstalled' &&
                plugin.spec.components.workbench
            )
            .map(plugin => plugin.spec.source.pluginKey)
        )
      }
      if (!cancelled) {
        await loader.reconcile(filterDesiredPlugins(localPlugins, desiredNames))
      }
    }

    void load().catch(error => {
      console.error('[Wework] Failed to load workbench plugins:', error)
    })

    return () => {
      cancelled = true
      void loader.dispose()
    }
  }, [cloud.apiBaseUrl, cloud.isConnected, cloud.serviceKey, cloud.token])

  return null
}
