import type { InteractionHistory } from './RuntimeInteractionsContext'
import {
  interactionId,
  interactionOriginalScheme,
  interactionSource,
  isInteractionSource,
  type RuntimeInteraction,
} from './runtimeInteractions'
import { parseWeworkScheme } from './scheme'
import { issueHumanInteraction } from './issueHumanInteractions'
import type { IssueHumanRequest } from '@wegent/collaboration'

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

function validIssueResolution(value: unknown, id: string): boolean {
  if (
    !record(value) ||
    typeof value.questionIdentity !== 'string' ||
    value.nativeInteractionId !== id
  )
    return false
  try {
    const identity: unknown = JSON.parse(value.questionIdentity)
    const native: unknown = JSON.parse(id)
    return (
      Array.isArray(identity) &&
      identity.length === 5 &&
      ['local', 'backend'].includes(identity[0]) &&
      identity.every(part => typeof part === 'string' && part.length > 0) &&
      Array.isArray(native) &&
      native.length === 3 &&
      native.every(part => typeof part === 'string' && part.length > 0) &&
      native[1] === identity[3] &&
      native[2] === `item:${identity[4]}`
    )
  } catch {
    return false
  }
}

/** Last-known requests remain visible offline, but never carry response authority. */
export function readPendingInteractionCache(key: string): RuntimeInteraction[] {
  const rows = read(key)
  if (!Array.isArray(rows)) return []
  return rows.flatMap<RuntimeInteraction>(row => {
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
    if (
      record(row.sharedRequest) &&
      ['local', 'backend'].includes(String(row.projectStore)) &&
      [
        'id',
        'project_id',
        'issue_id',
        'root_comment_id',
        'runtime_device_id',
        'runtime_task_id',
        'item_id',
        'question',
        'created_at',
        'updated_at',
      ].every(
        key =>
          typeof row.sharedRequest === 'object' &&
          row.sharedRequest !== null &&
          typeof (row.sharedRequest as Record<string, unknown>)[key] === 'string'
      ) &&
      ['pending', 'answering', 'resolved', 'cancelled'].includes(String(row.sharedRequest.status))
    ) {
      const item = issueHumanInteraction(
        row.sharedRequest as unknown as IssueHumanRequest,
        row.projectStore as 'local' | 'backend'
      )
      return [
        {
          ...item,
          cached: true,
          task: { ...item.task, workspace: { ...item.task.workspace, available: false } },
        },
      ]
    }
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
        createdAt: row.createdAt,
        payload: { kind: 'request_user_input' },
        answered: false,
        cached: true,
        source: isInteractionSource(row.source) ? row.source : undefined,
        sourceMessageIds:
          Array.isArray(row.sourceMessageIds) &&
          row.sourceMessageIds.every(id => typeof id === 'string')
            ? row.sourceMessageIds
            : undefined,
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
    source: interactionSource(item),
    title: item.task.task.title,
    runtime: item.task.task.runtime,
    workspacePath: item.task.task.workspacePath,
    question: item.question,
    createdAt: item.createdAt,
    originalUrl: interactionOriginalScheme(item),
    sourceMessageIds: item.sourceMessageIds,
    sharedRequest: item.sharedRequest,
    projectStore: item.project?.store,
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
        (row.resolvedIssueQuestion === undefined ||
          validIssueResolution(row.resolvedIssueQuestion, row.id)) &&
        (row.source === undefined || isInteractionSource(row.source)) &&
        typeof row.title === 'string' &&
        typeof row.question === 'string' &&
        typeof row.answeredAt === 'number' &&
        Number.isFinite(row.answeredAt) &&
        record(row.address) &&
        typeof row.address.deviceId === 'string' &&
        typeof row.address.taskId === 'string' &&
        (row.sourceMessageIds === undefined ||
          (Array.isArray(row.sourceMessageIds) &&
            row.sourceMessageIds.every(id => typeof id === 'string'))) &&
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
  const previous = current.find(row => row.id === entry.id)
  if (previous) {
    if (
      !entry.resolvedIssueQuestion ||
      JSON.stringify(previous.resolvedIssueQuestion) === JSON.stringify(entry.resolvedIssueQuestion)
    )
      return current
    return current.map(row =>
      row === previous ? { ...row, resolvedIssueQuestion: entry.resolvedIssueQuestion } : row
    )
  }
  const next = [...current, entry].sort((a, b) => b.answeredAt - a.answeredAt).slice(0, 100)
  return next.some((row, index) => row !== current[index]) ? next : current
}
