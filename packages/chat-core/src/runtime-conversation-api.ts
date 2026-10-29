import type {
  RuntimeFileChangesRevertRequest,
  RuntimeFileChangesRevertResponse,
} from './runtime-file-changes'
import type { RuntimeTaskAddress } from './runtime'
import type {
  RuntimeTaskCreateIntent,
  RuntimeTaskCreateResponse,
  RuntimeSendRequest,
  RuntimeSendResponse,
  RuntimeGuidanceRequest,
  RuntimeGuidanceResponse,
  RuntimeWorkListResponse,
  RuntimeTaskCancelResponse,
  RuntimeGoalGetRequest,
  RuntimeGoalGetResponse,
} from './runtime-task-api-types'

interface ConversationHttpClient {
  get<T>(path: string, options?: { signal?: AbortSignal }): Promise<T>
  post<T>(path: string, body: unknown): Promise<T>
}

/** Canonical backend runtime operations, also used by the PC cloud adapter. */
export function createRuntimeConversationApi(client: ConversationHttpClient) {
  return {
    revertRuntimeFileChanges(
      request: RuntimeFileChangesRevertRequest
    ): Promise<RuntimeFileChangesRevertResponse> {
      return client.post('/runtime-work/file-changes/revert', request)
    },
    getRuntimeGoal(data: RuntimeGoalGetRequest): Promise<RuntimeGoalGetResponse> {
      return client.post('/runtime-work/goal/get', data)
    },
    async createRuntimeTask<Request extends RuntimeTaskCreateIntent>(
      data: Request,
      beforeDispatch?: () => Promise<void>
    ): Promise<RuntimeTaskCreateResponse> {
      await beforeDispatch?.()
      return client.post('/runtime-work/create', data)
    },
    listRuntimeWork(options?: {
      signal?: AbortSignal
      preferCached?: boolean
      pendingOnly?: boolean
      deviceId?: string
      requireExplicitProjectRoots?: boolean
    }): Promise<RuntimeWorkListResponse> {
      const query = new URLSearchParams()
      if (options?.pendingOnly) query.set('pending_only', 'true')
      if (options?.deviceId) query.set('device_id', options.deviceId)
      const path = `/runtime-work${query.size ? `?${query}` : ''}`
      return options?.signal ? client.get(path, { signal: options.signal }) : client.get(path)
    },
    sendRuntimeMessage(data: RuntimeSendRequest): Promise<RuntimeSendResponse> {
      return client.post('/runtime-work/send', data)
    },
    interruptAndSendRuntimeMessage(data: RuntimeSendRequest): Promise<RuntimeSendResponse> {
      return client.post('/runtime-work/interrupt-and-send', data)
    },
    guideRuntimeTask(data: RuntimeGuidanceRequest): Promise<RuntimeGuidanceResponse> {
      return client.post('/runtime-work/guidance', data)
    },
    cancelRuntimeTask(address: RuntimeTaskAddress): Promise<RuntimeTaskCancelResponse> {
      return client.post('/runtime-work/cancel', address)
    },
  }
}
