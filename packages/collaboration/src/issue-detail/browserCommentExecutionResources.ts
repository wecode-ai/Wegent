import { createAsyncResource } from '@wegent/chat-core/async-resource'
import type { UnifiedModel } from '@wegent/chat-core/models'
import type { SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'

type ModelResource = ReturnType<typeof createAsyncResource<UnifiedModel[]>>

/** A runtime owner refreshes its catalog and observed model pickers without loading inactive devices. */
export function createBrowserCommentExecutionResources(runtime: SharedWorkspaceRuntimeApi) {
  const activeModels = new Set<ModelResource>()
  const catalog = createAsyncResource('browser/comment-execution', async signal => {
    const [devices, work] = await Promise.all([
      runtime.listDevices(),
      runtime.work.listRuntimeWork({ signal }),
    ])
    return { devices, work }
  })
  return {
    catalog,
    modelsFor(deviceId: string) {
      const resource = createAsyncResource('browser/comment-models', () =>
        runtime.listModels(deviceId)
      )
      return {
        ...resource,
        subscribe(listener: () => void) {
          activeModels.add(resource)
          const unsubscribe = resource.subscribe(listener)
          return () => {
            unsubscribe()
            if (!resource.hasSubscribers()) activeModels.delete(resource)
          }
        },
      }
    },
    retry() {
      if (catalog.hasSubscribers()) void catalog.reload()
      for (const models of activeModels) void models.reload()
    },
  }
}
