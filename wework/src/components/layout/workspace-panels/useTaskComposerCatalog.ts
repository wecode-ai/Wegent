import { useMemo } from 'react'
import { createRuntimeComposerPluginSource } from '@wegent/chat-core/runtime-composer-plugin-source'
import { readWorkspaceFileBytes } from '@wegent/chat-core/workspace-file-bytes'
import { createComposerCatalogStore } from '@wegent/collaboration/composer/createComposerCatalogStore'
import { createComposerPluginAssetReader } from '@wegent/collaboration/composer/pluginAssetReader'
import type { ComposerCatalogBinding } from '@/components/chat/composer/ComposerCatalogContext'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { LOCAL_PLUGIN_SKILLS_CHANGED_EVENT } from '@/features/plugins/pluginTrial'
import type { RuntimeTaskAddress } from '@/types/api'

export function useTaskComposerCatalog(
  address: RuntimeTaskAddress | null,
  services: WorkbenchServices,
  translate: (key: string) => string
): ComposerCatalogBinding {
  const deviceId = address?.deviceId
  const taskId = address?.taskId
  const readCatalog = services.composerCatalogApi?.readCatalog
  const readChunk = services.deviceApi.readWorkspaceFileChunk
  return useMemo(() => {
    const binding: ComposerCatalogBinding = {
      appsStore: createComposerCatalogStore(),
      catalogEvents: { catalogChanged: LOCAL_PLUGIN_SKILLS_CHANGED_EVENT },
      prefetchLocalAuth: !taskId,
    }
    // Before creation, the composer's project controls supply its contextual catalog.
    // Once bound, neither picker nor slash may use the main workbench's task catalog.
    if (!deviceId || !taskId) return binding
    const source = createRuntimeComposerPluginSource(
      (target, refresh) => {
        if (!readCatalog) throw new Error('Composer catalog service is unavailable')
        return readCatalog(target, refresh)
      },
      { deviceId, taskId },
      translate,
      createComposerPluginAssetReader(async (reference, mimeType) => {
        if (!readChunk) throw new Error('Workspace file reader is unavailable')
        const bytes = await readWorkspaceFileBytes(reference, readChunk)
        return new Blob([bytes], { type: mimeType })
      }, deviceId)
    )
    return { ...binding, listApps: source.listApps, listSkills: source.listSkills }
  }, [deviceId, taskId, readCatalog, readChunk, translate])
}
