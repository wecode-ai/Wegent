export type RuntimeCommandNative = [generation: number, threadId: string, turnId: string] | null

export interface RuntimeCommandTarget {
  taskId: string
  commandId: string
  userId: number
}

export interface RuntimeCommandReceipt {
  success: boolean
  accepted: boolean
  taskId: string
  commandId: string
  taskTitle: string
  commandFingerprint: string
  native: RuntimeCommandNative
  state:
    | 'queued'
    | 'dispatching'
    | 'started'
    | 'failed'
    | 'settled'
    | 'awaiting_user'
    | 'cancelled'
    | 'recovery_required'
    | 'abandoned'
  acceptedAt: number
  runtime: string
  requiresUserReview: boolean
  nativeOutcome?: 'unknown'
  ownerResolution?: {
    requestId: string
    userId: number
    deviceId: string
    at: number
    previousState: 'recovery_required'
    nativeOutcome: 'unknown'
  }
}

export interface RuntimeCommandResolution extends RuntimeCommandTarget {
  expectedFingerprint: string
  expectedNative: RuntimeCommandNative
  decision: 'abandon'
  requestId: string
}

export interface RuntimeTaskCommandsApi {
  get(deviceId: string, target: RuntimeCommandTarget): Promise<RuntimeCommandReceipt>
  resolve(deviceId: string, resolution: RuntimeCommandResolution): Promise<RuntimeCommandReceipt>
}

export function createRuntimeTaskCommandsApi(
  request: <T>(method: string, payload: Record<string, unknown>, deviceId: string) => Promise<T>
): RuntimeTaskCommandsApi {
  return {
    get: (deviceId, target) => request('runtime.tasks.commands.get', { ...target }, deviceId),
    resolve: (deviceId, resolution) =>
      request('runtime.tasks.commands.resolve', { ...resolution }, deviceId),
  }
}
