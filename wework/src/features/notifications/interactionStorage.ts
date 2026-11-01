import type { InteractionHistory } from './RuntimeInteractionsContext'
import {
  interactionId,
  interactionOriginalScheme,
  type RuntimeInteraction,
} from './runtimeInteractions'
import { parseWeworkScheme } from './scheme'

function read(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null')
  } catch {
    return null
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/** Last-known requests remain visible offline, but never carry response authority. */
export function readPendingInteractionCache(key: string): RuntimeInteraction[] {
  const rows = read(key)
  if (!Array.isArray(rows)) return []
  return rows.flatMap(row => {
    if (
      !record(row) ||
      !record(row.address) ||
      typeof row.address.deviceId !== 'string' ||
      typeof row.address.taskId !== 'string' ||
      !row.address.deviceId ||
      !row.address.taskId ||
      typeof row.runtime !== 'string' ||
      typeof row.workspacePath !== 'string' ||
      typeof row.requestKey !== 'string' ||
      typeof row.title !== 'string' ||
      typeof row.question !== 'string' ||
      typeof row.createdAt !== 'number' ||
      !Number.isFinite(row.createdAt)
    )
      return []
    const address = { deviceId: row.address.deviceId, taskId: row.address.taskId }
    const task = {
      key: `${address.deviceId}\0${address.taskId}`,
      address,
      task: {
        taskId: address.taskId,
        title: row.title,
        runtime: row.runtime,
        workspacePath: row.workspacePath,
        interactionStatus: 'awaitingUserReply' as const,
      },
      workspace: { deviceId: address.deviceId, available: false, workspacePath: '', tasks: [] },
      projectName: '',
    }
    return [
      {
        id: interactionId(task, row.requestKey),
        requestKey: row.requestKey,
        task,
        question: row.question,
        context: '',
        createdAt: row.createdAt,
        payload: { kind: 'request_user_input' },
        answered: false,
        cached: true,
        originalUrl:
          typeof row.originalUrl === 'string' && parseWeworkScheme(row.originalUrl)
            ? row.originalUrl
            : undefined,
      },
    ]
  })
}

export function pendingInteractionCache(items: RuntimeInteraction[]) {
  return items.map(item => ({
    address: { deviceId: item.task.address.deviceId, taskId: item.task.address.taskId },
    requestKey: item.requestKey,
    title: item.task.task.title,
    runtime: item.task.task.runtime,
    workspacePath: item.task.task.workspacePath,
    question: item.question,
    createdAt: item.createdAt,
    originalUrl: interactionOriginalScheme(item),
  }))
}

export function readInteractionHistory(key: string): InteractionHistory[] {
  const value = read(key)
  if (!Array.isArray(value)) return []
  return value
    .filter(
      (row): row is InteractionHistory =>
        record(row) &&
        typeof row.id === 'string' &&
        typeof row.title === 'string' &&
        typeof row.question === 'string' &&
        typeof row.answeredAt === 'number' &&
        Number.isFinite(row.answeredAt) &&
        record(row.address) &&
        typeof row.address.deviceId === 'string' &&
        typeof row.address.taskId === 'string' &&
        (row.originalUrl === undefined || typeof row.originalUrl === 'string')
    )
    .sort((a, b) => b.answeredAt - a.answeredAt)
    .slice(0, 100)
}

export function readInteractionDrafts(key: string): Record<string, string> {
  const value = read(key)
  return record(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    : {}
}

export function saveInteractionState(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (error) {
    console.error('[Wework] Could not persist interaction state', error)
  }
}

/** Keep stable ordering and avoid re-adding evicted history on every transcript poll. */
export function archiveInteraction(
  current: InteractionHistory[],
  entry: InteractionHistory
): InteractionHistory[] {
  if (current.some(row => row.id === entry.id)) return current
  const next = [...current, entry].sort((a, b) => b.answeredAt - a.answeredAt).slice(0, 100)
  return next.some((row, index) => row !== current[index]) ? next : current
}
