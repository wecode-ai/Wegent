import type { createDeliveryApi } from '@/api/deliveries'

type DeliveryApi = ReturnType<typeof createDeliveryApi>

// Backend-owned project spaces always execute through Backend. The Backend
// selects MySQL, GitHub, or GitLab from task_provider and remains the final
// authorization boundary. Cloud credentials and requests never enter Executor.
export function createCloudProjectSpaceApi(storeApi: DeliveryApi): DeliveryApi {
  return { ...storeApi }
}
