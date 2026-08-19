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
  if (!desiredNames) return localPlugins
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

    const load = async () => {
      const currentGeneration = ++generation
      const [localPlugins, installed] = await Promise.all([
        listDeviceWorkbenchPlugins(),
        pluginApi.listInstalledPlugins(),
      ])
      const desiredNames = new Set(
        installed.items
          .filter(plugin => plugin.spec.enabled && plugin.spec.installState !== 'uninstalled')
          .map(plugin => plugin.spec.source.pluginKey)
      )
      if (!cancelled && currentGeneration === generation) {
        await loader.reconcile(filterDesiredPlugins(localPlugins, desiredNames))
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
      void loader.dispose()
    }
  }, [])

  return null
}
