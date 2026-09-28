import type { RuntimeExecutionSnapshot } from './project-chat'
import type { RuntimeTaskAddress, RuntimeTranscriptResponse } from './runtime'
import { projectRuntimePaneTranscript } from './runtime-transcript-page'

/** Send compact execution facts; conversation text stays on the runtime. */
export function runtimeExecutionSnapshot(
  address: RuntimeTaskAddress,
  response: RuntimeTranscriptResponse,
): RuntimeExecutionSnapshot | undefined {
  if (response.historyUnavailable || response.parseError) return undefined
  if (response.taskId && response.taskId !== address.taskId) return undefined
  const transcript = projectRuntimePaneTranscript(response)
  const turns: RuntimeExecutionSnapshot['turns'] = transcript.turns.flatMap(
    (turn) => {
      if (!turn.id) return []
      return [
        {
          id: turn.id,
          userMessageIds: [
            ...new Set([
              ...(turn.clientUserMessageId ? [turn.clientUserMessageId] : []),
              ...turn.items.flatMap((item) =>
                item.type === 'user_message' ? [item.id] : [],
              ),
            ]),
          ],
          status: executionStatus(
            response.turns.find((candidate) => candidate.id === turn.id),
          ),
          completedAt: turn.completedAt,
        },
      ]
    },
  )
  if (
    !turns.some((turn) => ['done', 'failed', 'cancelled'].includes(turn.status))
  )
    return undefined
  return {
    deviceId: address.deviceId,
    taskId: address.taskId,
    running: response.running,
    completeHistory:
      response.rangeStart === 0 &&
      !response.hasMoreBefore &&
      !response.hasMoreAfter,
    turns,
  }
}

function executionStatus(
  turn: RuntimeTranscriptResponse['turns'][number] | undefined,
): RuntimeExecutionSnapshot['turns'][number]['status'] {
  const status = (turn?.runtimeStatus ?? turn?.status ?? '').toLowerCase()
  if (['done', 'completed', 'succeeded'].includes(status)) return 'done'
  if (['failed', 'error'].includes(status)) return 'failed'
  if (['cancelled', 'canceled', 'interrupted', 'aborted'].includes(status))
    return 'cancelled'
  if (['running', 'streaming', 'in_progress'].includes(status)) return 'running'
  return 'unknown'
}
