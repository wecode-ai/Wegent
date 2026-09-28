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
    }): Promise<RuntimeWorkListResponse> {
      return options?.signal
        ? client.get('/runtime-work', { signal: options.signal })
        : client.get('/runtime-work')
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
