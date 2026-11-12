import type { CloudProject } from '@/api/deliveries'
import type { createLocalProjectChatAgentApi } from './localDelivery'

/** Carry the actual container into previews without consulting unrelated catalogs. */
export function localAgentResourceContext(
  api: ReturnType<typeof createLocalProjectChatAgentApi>,
  container: CloudProject
): ReturnType<typeof createLocalProjectChatAgentApi> {
  const scope = (id?: string) => id == null || id === String(container.id)
  return {
    ...api,
    listRunnerEnvironments: id =>
      scope(id)
        ? api.listRunnerEnvironments(String(container.id), container)
        : api.listRunnerEnvironments(id),
    listEnvironments: id =>
      scope(id) ? api.listEnvironments(String(container.id), container) : api.listEnvironments(id),
  }
}
