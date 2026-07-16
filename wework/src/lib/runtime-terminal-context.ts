import type { RuntimeAdditionalContext, RuntimeTaskAddress } from '@/types/api'
import {
  APP_PREFERENCES_CHANGED_EVENT,
  defaultAppPreferences,
  getAppPreferences,
  type AppPreferences,
} from '@/tauri/appPreferences'
export type {
  RuntimeAdditionalContext,
  RuntimeAdditionalContextEntry,
  RuntimeAdditionalContextKind,
} from '@/types/api'

interface TerminalContextTarget {
  taskId?: string | null
  workspacePath?: string | null
}

export interface TerminalContextAppendInput extends TerminalContextTarget {
  sessionId: string
  title?: string | null
  cwd?: string | null
  kind?: 'local' | 'remote' | string | null
  data: string
}

interface TerminalContextRecord {
  targetKeys: string[]
  sessionId: string
  title?: string | null
  cwd?: string | null
  kind?: string | null
  chunks: TerminalContextChunk[]
  length: number
  lastDeliveredChunkId: number
  updatedAt: number
  truncated: boolean
}

interface TerminalContextChunk {
  id: number
  value: string
}

interface PendingTerminalContextDelivery {
  sessionId: string
  lastChunkId: number
}

const TERMINAL_CONTEXT_KEY = 'wework.terminal.current'
const MAX_TERMINAL_CONTEXT_BYTES = 2 * 1024
const MAX_TERMINAL_CONTEXT_LINES = 80
const MAX_TERMINAL_CHUNK_BYTES = 512
const recordsBySession = new Map<string, TerminalContextRecord>()
const sessionIdsByTarget = new Map<string, Set<string>>()
const pendingDeliveriesByValue = new Map<string, PendingTerminalContextDelivery>()
let terminalContextInjectionEnabled = defaultAppPreferences.terminalContextInjectionEnabled
let preferencesListenerInstalled = false
let nextChunkId = 1

installPreferencesListener()

export function appendRuntimeTerminalContext(input: TerminalContextAppendInput): void {
  const text = sanitizeTerminalOutput(input.data)
  if (!text) return

  const targetKeys = terminalTargetKeys(input)
  if (targetKeys.length === 0) return

  const record = recordsBySession.get(input.sessionId) ?? {
    targetKeys,
    sessionId: input.sessionId,
    chunks: [],
    length: 0,
    lastDeliveredChunkId: 0,
    updatedAt: Date.now(),
    truncated: false,
  }

  record.title = input.title ?? record.title
  record.cwd = input.cwd ?? record.cwd
  record.kind = input.kind ?? record.kind
  record.updatedAt = Date.now()
  record.targetKeys = targetKeys

  const chunk = tail(text, MAX_TERMINAL_CHUNK_BYTES)
  const chunkId = nextChunkId
  nextChunkId += 1
  record.chunks.push({ id: chunkId, value: chunk })
  record.length += chunk.length

  while (record.length > MAX_TERMINAL_CONTEXT_BYTES && record.chunks.length > 1) {
    const removed = record.chunks.shift()
    record.length -= removed?.value.length ?? 0
    record.truncated = true
  }

  recordsBySession.set(input.sessionId, record)
  for (const key of targetKeys) {
    const sessions = sessionIdsByTarget.get(key) ?? new Set<string>()
    sessions.add(input.sessionId)
    sessionIdsByTarget.set(key, sessions)
  }
}

export function readRuntimeTerminalAdditionalContext(
  address: RuntimeTaskAddress | null | undefined
): RuntimeAdditionalContext | undefined {
  if (!terminalContextInjectionEnabled) return undefined

  const targetKeys = terminalTargetKeys(address ?? {})
  const records = targetKeys
    .flatMap(key => Array.from(sessionIdsByTarget.get(key) ?? []))
    .map(sessionId => recordsBySession.get(sessionId))
    .filter((record): record is TerminalContextRecord => Boolean(record))
    .sort((left, right) => right.updatedAt - left.updatedAt)

  const latest = records[0]
  if (!latest) return undefined

  const pendingChunks = latest.chunks.filter(chunk => chunk.id > latest.lastDeliveredChunkId)
  const output = tailLines(
    pendingChunks.map(chunk => chunk.value).join(''),
    MAX_TERMINAL_CONTEXT_LINES
  ).trim()
  if (!output) return undefined

  const value = [
    'Wework terminal context:',
    `kind: ${latest.kind ?? 'unknown'}`,
    `sessionId: ${latest.sessionId}`,
    latest.title ? `title: ${latest.title}` : null,
    latest.cwd ? `cwd: ${latest.cwd}` : null,
    `capturedAt: ${new Date(latest.updatedAt).toISOString()}`,
    `truncated: ${latest.truncated}`,
    'new output since the last delivered terminal context:',
    output,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n')
  const lastChunkId = pendingChunks[pendingChunks.length - 1]?.id
  if (lastChunkId === undefined) return undefined
  pendingDeliveriesByValue.set(value, { sessionId: latest.sessionId, lastChunkId })

  return {
    [TERMINAL_CONTEXT_KEY]: {
      kind: 'application',
      value,
    },
  }
}

export function markRuntimeTerminalAdditionalContextDelivered(
  context: RuntimeAdditionalContext | undefined
): void {
  const value = context?.[TERMINAL_CONTEXT_KEY]?.value
  if (!value) return

  const delivery = pendingDeliveriesByValue.get(value)
  if (!delivery) return

  const record = recordsBySession.get(delivery.sessionId)
  if (record) {
    record.lastDeliveredChunkId = Math.max(record.lastDeliveredChunkId, delivery.lastChunkId)
  }
  for (const [pendingValue, pendingDelivery] of pendingDeliveriesByValue) {
    if (
      pendingDelivery.sessionId === delivery.sessionId &&
      pendingDelivery.lastChunkId <= delivery.lastChunkId
    ) {
      pendingDeliveriesByValue.delete(pendingValue)
    }
  }
}

export function isRuntimeTerminalContextInjectionEnabled(): boolean {
  return terminalContextInjectionEnabled
}

export function mergeRuntimeAdditionalContext(
  base: RuntimeAdditionalContext | undefined,
  extra: RuntimeAdditionalContext | undefined
): RuntimeAdditionalContext | undefined {
  if (!base) return extra
  if (!extra) return base
  return { ...base, ...extra }
}

export function resetRuntimeTerminalContextForTests(): void {
  recordsBySession.clear()
  sessionIdsByTarget.clear()
  pendingDeliveriesByValue.clear()
  nextChunkId = 1
  terminalContextInjectionEnabled = defaultAppPreferences.terminalContextInjectionEnabled
}

function terminalTargetKeys(target: TerminalContextTarget): string[] {
  return [
    target.taskId ? `task:${target.taskId}` : null,
    target.workspacePath ? `workspace:${target.workspacePath}` : null,
  ].filter((key): key is string => Boolean(key))
}

function sanitizeTerminalOutput(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
  )
}

function tail(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(value.length - maxLength) : value
}

function tailLines(value: string, maxLines: number): string {
  const lines = value.split('\n')
  return lines.length > maxLines ? lines.slice(lines.length - maxLines).join('\n') : value
}

function installPreferencesListener(): void {
  if (preferencesListenerInstalled || typeof window === 'undefined') return
  preferencesListenerInstalled = true

  void getAppPreferences()
    .then(applyTerminalContextPreference)
    .catch(error => {
      console.error('[Wework] Failed to load terminal context preference', error)
    })

  window.addEventListener(APP_PREFERENCES_CHANGED_EVENT, event => {
    const preferences = (event as CustomEvent<AppPreferences>).detail
    applyTerminalContextPreference(preferences)
  })
}

function applyTerminalContextPreference(preferences: AppPreferences): void {
  terminalContextInjectionEnabled = preferences.terminalContextInjectionEnabled
}
