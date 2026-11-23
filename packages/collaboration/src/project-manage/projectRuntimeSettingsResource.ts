import { createAsyncResource } from '@wegent/chat-core/async-resource'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { ProfileConfigurationTarget } from '../runtime-profile/context'

export class RuntimeCatalogUnavailableError extends Error {}

/** The mounted project/target owns both catalog reads and accepted local mutations. */
export function createProjectRuntimeSettingsResource(
  api: SharedWorkspaceApi,
  projectId: string,
  target: ProfileConfigurationTarget | undefined
) {
  const resource = createAsyncResource('project-runtime-settings', async () => {
    if (!api.automationExecutionCatalog) throw new RuntimeCatalogUnavailableError()
    const [catalog, binding] = await Promise.all([
      api.automationExecutionCatalog.load(projectId),
      target
        ? Promise.resolve({ runtimeProfileId: null })
        : api.runtimeProfiles.getProjectDefault(projectId),
    ])
    return { catalog, defaultId: binding.runtimeProfileId, readId: Symbol('runtime-catalog-read') }
  })
  return { ...resource, isActive: resource.hasSubscribers }
}
