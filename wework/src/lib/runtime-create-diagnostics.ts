import type { RuntimePaneQueuedMessage } from '@/types/workbench'

const LOG_PREFIX = '[Wework] Runtime task create diagnostic'

function serializeDiagnostic(entry: Record<string, unknown>): string {
  try {
    return JSON.stringify(entry)
  } catch {
    return JSON.stringify({
      stage: entry.stage,
      serializationFailed: true,
    })
  }
}

export function logRuntimeTaskCreateStage(stage: string, details: Record<string, unknown>): void {
  const entry = {
    timestamp: new Date().toISOString(),
    stage,
    ...details,
  }
  console.info(LOG_PREFIX, serializeDiagnostic(entry))
}

export function summarizeRuntimeQueue(messages: readonly RuntimePaneQueuedMessage[]) {
  return {
    queueLength: messages.length,
    localQueuedCount: messages.filter(
      message => message.status === 'queued' && !message.runtimeQueued
    ).length,
    runtimeQueuedCount: messages.filter(message => message.runtimeQueued).length,
    failedCount: messages.filter(message => message.status === 'failed').length,
    sendingCount: messages.filter(message => message.status === 'sending').length,
    pendingGuidanceCount: messages.filter(
      message => message.status === 'sending' && message.deliveryMode === 'guidance'
    ).length,
    messages: messages.slice(0, 10).map(message => ({
      id: message.id,
      status: message.status,
      createdAt: message.createdAt,
      runtimeQueued: message.runtimeQueued === true,
      awaitingTurnStart: message.awaitingTurnStart === true,
      hasInitialGoal: Boolean(message.initialGoal),
      deliveryMode: message.deliveryMode ?? null,
    })),
  }
}
