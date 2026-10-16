import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { ModelSelectionConfig } from '@/types/api'
import {
  cancellableTextGeneration,
  textGenerationRequest,
} from '@/features/reply-predictions/textGenerationCancellation'

export function createReplyPredictionApi(
  request: <T>(method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<T>,
  resolveModelConfig: (
    selection: ModelSelectionConfig | null | undefined
  ) => Promise<Record<string, unknown> | undefined>
): NonNullable<WorkbenchServices['replyPredictionApi']> {
  return {
    predict(data) {
      return cancellableTextGeneration(data.signal, 30000, async signal => {
        const modelConfig = await resolveModelConfig(data.modelSelection)
        signal.throwIfAborted()
        const requestId = `reply-prediction-${crypto.randomUUID()}`
        return textGenerationRequest(
          signal,
          () =>
            request<{ suggestion: string | null }>(
              'runtime.text.predict_reply',
              {
                ...data.address,
                latestTurnId: data.latestTurnId,
                requestId,
                ...(modelConfig ? { modelConfig } : {}),
              },
              signal
            ),
          () =>
            request('runtime.text.cancel', {
              deviceId: data.address.deviceId,
              taskId: requestId,
            })
        )
      })
    },
  }
}
