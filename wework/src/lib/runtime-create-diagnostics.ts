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

export function logRuntimeTaskCreateStage(
  stage: string,
  details: Record<string, unknown>,
  level: 'info' | 'debug' = 'info'
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    stage,
    ...details,
  }
  console[level](LOG_PREFIX, serializeDiagnostic(entry))
}

export function runtimeOriginDiagnostic(origin: unknown): Record<string, unknown> {
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) {
    return { originPresent: false }
  }
  const source = origin as Record<string, unknown>
  const knownValues = [
    'board_task',
    'issue_dispatch',
    'stand_in_identity',
    'connection_work',
    'dingtalk_work',
    'stand_in',
    'manager',
    'executor',
  ]
  const fields = [
    'type',
    'initiatedBy',
    'dispatchRole',
    'dispatch_role',
    'dispatchId',
    'dispatch_id',
  ]
  const markers = Object.fromEntries(
    fields.map(field => {
      const value = source[field]
      const classification =
        value === undefined
          ? 'missing'
          : value === null
            ? 'null'
            : typeof value !== 'string'
              ? 'non_string'
              : !value.trim()
                ? 'empty_string'
                : knownValues.includes(value)
                  ? value
                  : 'nonempty_string'
      return [field, classification]
    })
  )
  return { originPresent: true, originMarkers: markers }
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
