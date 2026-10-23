import { useMemo } from 'react'
import { createRuntimeComposerPluginSource } from '@wegent/chat-core/runtime-composer-plugin-source'
import { readWorkspaceFileBytes } from '@wegent/chat-core/workspace-file-bytes'
import { createComposerCatalogStore } from '@wegent/collaboration/composer/createComposerCatalogStore'
import { createComposerPluginAssetReader } from '@wegent/collaboration/composer/pluginAssetReader'
import type { ComposerCatalogBinding } from '@/components/chat/composer/ComposerCatalogContext'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { LOCAL_PLUGIN_SKILLS_CHANGED_EVENT } from '@/features/plugins/pluginTrial'
import type { RuntimeComposerCatalogTarget } from '@wegent/chat-core/runtime-composer-snapshot'

export function useRuntimeComposerCatalog(
  address: RuntimeComposerCatalogTarget | null,
  services: WorkbenchServices | undefined,
  translate: (key: string) => string
): ComposerCatalogBinding {
  const deviceId = address?.deviceId
  const taskId = address?.taskId
  const scope = address && 'scope' in address ? address.scope : undefined
  const workspacePath = address && 'scope' in address ? address.workspacePath : null
  const readCatalog = services?.composerCatalogApi?.readCatalog
  const readChunk = services?.deviceApi?.readWorkspaceFileChunk
  return useMemo(() => {
    const binding: ComposerCatalogBinding = {
      appsStore: createComposerCatalogStore(),
      catalogEvents: { catalogChanged: LOCAL_PLUGIN_SKILLS_CHANGED_EVENT },
    }
    // Each binding owns its device and task or workspace; catalogs never cross scopes.
    if (!deviceId || (!taskId && !scope)) return binding
    const source = createRuntimeComposerPluginSource(
      (target, refresh) => {
        if (!readCatalog) throw new Error('Composer catalog service is unavailable')
        return readCatalog(target, refresh)
      },
      scope ? { deviceId, scope, workspacePath } : { deviceId, taskId: taskId! },
      translate,
      createComposerPluginAssetReader(async (reference, mimeType) => {
        if (!readChunk) throw new Error('Workspace file reader is unavailable')
        const bytes = await readWorkspaceFileBytes(reference, readChunk)
        return new Blob([bytes], { type: mimeType })
      }, deviceId)
    )
    return { ...binding, listApps: source.listApps, listSkills: source.listSkills }
  }, [deviceId, taskId, scope, workspacePath, readCatalog, readChunk, translate])
}
