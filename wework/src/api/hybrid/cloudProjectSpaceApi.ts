import type { createDeliveryApi } from '@/api/deliveries'
import type { ExternalIssueApi } from '@/features/workbench/workbenchServices'

type DeliveryApi = ReturnType<typeof createDeliveryApi>

// Backend-owned project spaces always execute through Backend. The Backend
// selects MySQL, GitHub, or GitLab from task_provider and remains the final
// authorization boundary. externalIssueApi is retained in the signature while
// callers migrate, but cloud credentials and requests never enter Executor.
export function createCloudProjectSpaceApi(
  storeApi: DeliveryApi,
  externalIssueApi: ExternalIssueApi
): DeliveryApi {
  return {
    ...storeApi,
    async listCloudProjects() {
      // Remove credentials/catalog entries written by older Wework versions.
      // Backend-owned projects never execute through the local task runtime.
      await externalIssueApi.retainProjects?.([])
      return storeApi.listCloudProjects()
    },
  }
}
