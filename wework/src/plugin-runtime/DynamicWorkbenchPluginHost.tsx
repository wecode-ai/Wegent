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

let reconciliationQueue: Promise<void> = Promise.resolve()

export function DynamicWorkbenchPluginHost() {
  const cloud = useCloudConnection()

  useEffect(() => {
    const loader = new ExternalWorkbenchPluginLoader(getWorkbenchPluginRuntime())
    let cancelled = false

    const load = async () => {
      const localPlugins = await listDeviceWorkbenchPlugins()
      let desiredNames: Set<string> | null = null
      if (cloud.isConnected && cloud.apiBaseUrl) {
        try {
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
        } catch (error) {
          console.error('[Wework] Failed to load cloud plugin state; loading local plugins:', error)
        }
      }
      if (!cancelled) {
        await loader.reconcile(filterDesiredPlugins(localPlugins, desiredNames))
      }
    }

    const pending = reconciliationQueue.then(load).catch(error => {
      console.error('[Wework] Failed to load workbench plugins:', error)
    })
    reconciliationQueue = pending

    return () => {
      cancelled = true
      reconciliationQueue = pending
        .then(() => loader.dispose())
        .catch(error => {
          console.error('[Wework] Failed to dispose workbench plugins:', error)
        })
    }
  }, [cloud.apiBaseUrl, cloud.isConnected, cloud.serviceKey, cloud.token])

  return null
}
