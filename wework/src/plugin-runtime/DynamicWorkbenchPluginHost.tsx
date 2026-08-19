import { useEffect } from 'react'

import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import { LOCAL_PLUGIN_SKILLS_CHANGED_EVENT } from '@/features/plugins/pluginTrial'

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
  if (!desiredNames) return localPlugins.filter(plugin => plugin.manifest.required)
  return localPlugins.filter(
    plugin => plugin.manifest.required || desiredNames.has(plugin.manifest.name)
  )
}

export function DynamicWorkbenchPluginHost() {
  useEffect(() => {
    const loader = new ExternalWorkbenchPluginLoader(getWorkbenchPluginRuntime())
    const pluginApi = createLocalCodexPluginApi()
    let cancelled = false
    let generation = 0
    let reconcileChain = Promise.resolve()

    const load = async () => {
      const currentGeneration = ++generation
      const localPlugins = await listDeviceWorkbenchPlugins()
      let desiredNames: ReadonlySet<string> | null = null
      try {
        const installed = await pluginApi.listInstalledPlugins()
        desiredNames = new Set(
          installed.items
            .filter(plugin => plugin.spec.enabled && plugin.spec.installState !== 'uninstalled')
            .map(plugin => plugin.spec.source.pluginKey)
        )
      } catch (error) {
        console.warn(
          '[Wework] Failed to read local plugin state; loading required plugins only:',
          error
        )
      }
      if (!cancelled && currentGeneration === generation) {
        reconcileChain = reconcileChain
          .catch(() => undefined)
          .then(async () => {
            if (!cancelled && currentGeneration === generation) {
              await loader.reconcile(filterDesiredPlugins(localPlugins, desiredNames))
            }
          })
        await reconcileChain
      }
    }

    const refresh = () => {
      void load().catch(error => {
        console.error('[Wework] Failed to load workbench plugins:', error)
      })
    }

    window.addEventListener(LOCAL_PLUGIN_SKILLS_CHANGED_EVENT, refresh)
    refresh()

    return () => {
      cancelled = true
      window.removeEventListener(LOCAL_PLUGIN_SKILLS_CHANGED_EVENT, refresh)
      void reconcileChain.finally(() => loader.dispose())
    }
  }, [])

  return null
}
