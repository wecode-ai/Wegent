import type { ProjectChatMessage, RuntimeExecutionSnapshot } from '@wegent/chat-core'
import type { RuntimeTaskAddress, RuntimeTranscriptResponse } from '@wegent/chat-core/runtime'
import { getDesktopE2ERuntimeConfig } from '@/e2e/runtime-config'
import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'

export function logRuntimeExecutionProjection(
  stage: 'read' | 'acknowledged',
  address: RuntimeTaskAddress,
  response: RuntimeTranscriptResponse,
  snapshot?: RuntimeExecutionSnapshot,
  messages: ProjectChatMessage[] = []
) {
  const config = getDesktopE2ERuntimeConfig()
  if (!config.controlUrl || config.disabled) return
  logRuntimeTaskCreateStage('runtime-execution-projection', {
    projectionStage: stage,
    deviceId: address.deviceId,
    taskId: address.taskId,
    running: response.running,
    rangeStart: response.rangeStart,
    rangeEnd: response.rangeEnd,
    hasMoreBefore: response.hasMoreBefore,
    hasMoreAfter: response.hasMoreAfter,
    projectStore: response.origin?.projectStore,
    rawTurns: response.turns?.slice(-4).map(turn => ({
      id: turn.id,
      status: turn.status,
      runtimeStatus: turn.runtimeStatus,
    })),
    snapshot: snapshot ? { ...snapshot, turns: snapshot.turns.slice(-4) } : null,
    acknowledgmentType: Array.isArray(messages) ? 'array' : typeof messages,
    acknowledged: (Array.isArray(messages) ? messages : []).slice(-4).map(message => ({
      messageId: message.messageId,
      status: message.status,
      triggerMessageId: message.triggerMessageId,
      runtimeTurnId: message.metadata?.runtime_turn_id,
      executionId: message.metadata?.execution_id,
    })),
  })
}
