// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

const KEY_PREFIX = 'pet:prompt-draft:'
const MAX_VERSIONS = 3

export interface PromptDraftLocal {
  title: string
  prompt: string
  model: string
  version: number
  createdAt: string
  sourceConversationId: string
}

export type PromptDraftVersionSource = 'initial' | 'regenerate' | 'rollback'

export interface PromptDraftVersion extends PromptDraftLocal {
  id: string
  source: PromptDraftVersionSource
}

export interface PromptDraftVersionsState {
  currentVersionId: string
  versions: PromptDraftVersion[]
}

function getStorageKey(conversationId: string | number): string {
  return `${KEY_PREFIX}${conversationId}`
}

function createUniqueVersionId(existingIds: Set<string>): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    let candidate = crypto.randomUUID()
    while (existingIds.has(candidate)) {
      candidate = crypto.randomUUID()
    }
    return candidate
  }

  let candidate = `pdv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  while (existingIds.has(candidate)) {
    candidate = `pdv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }
  return candidate
}

function isPromptDraftVersion(value: unknown): value is PromptDraftVersion {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.title === 'string' &&
    typeof record.prompt === 'string' &&
    typeof record.model === 'string' &&
    typeof record.version === 'number' &&
    typeof record.createdAt === 'string' &&
    typeof record.sourceConversationId === 'string' &&
    (record.source === 'initial' || record.source === 'regenerate' || record.source === 'rollback')
  )
}

function isPromptDraftLocal(value: unknown): value is PromptDraftLocal {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.title === 'string' &&
    typeof record.prompt === 'string' &&
    typeof record.model === 'string' &&
    typeof record.version === 'number' &&
    typeof record.createdAt === 'string' &&
    typeof record.sourceConversationId === 'string' &&
    !('id' in record) &&
    !('source' in record) &&
    !('currentVersionId' in record) &&
    !('versions' in record)
  )
}

function isPromptDraftVersionsState(value: unknown): value is PromptDraftVersionsState {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.currentVersionId === 'string' &&
    Array.isArray(record.versions) &&
    record.versions.every(isPromptDraftVersion)
  )
}

function normalizeState(state: PromptDraftVersionsState): PromptDraftVersionsState {
  const deduped: PromptDraftVersion[] = []
  const seen = new Set<string>()

  for (const version of state.versions) {
    if (seen.has(version.id)) continue
    seen.add(version.id)
    deduped.push(version)
  }

  const currentIndex = deduped.findIndex(version => version.id === state.currentVersionId)
  if (currentIndex > 0) {
    const [current] = deduped.splice(currentIndex, 1)
    deduped.unshift(current)
  }

  const trimmed = deduped.slice(0, MAX_VERSIONS)
  return {
    currentVersionId: trimmed[0]?.id ?? state.currentVersionId,
    versions: trimmed,
  }
}

function clearStoredPromptDraft(conversationId: string | number): void {
  try {
    localStorage.removeItem(getStorageKey(conversationId))
  } catch {
    // ignore cleanup failure
  }
}

function readPromptDraftVersions(conversationId: string | number): PromptDraftVersionsState | null {
  try {
    const raw = localStorage.getItem(getStorageKey(conversationId))
    if (!raw) return null

    const parsed: unknown = JSON.parse(raw)
    if (isPromptDraftVersionsState(parsed)) {
      return normalizeState(parsed)
    }

    if (isPromptDraftLocal(parsed)) {
      const versionId = createUniqueVersionId(new Set())
      const migrated = normalizeState({
        currentVersionId: versionId,
        versions: [
          {
            ...parsed,
            id: versionId,
            source: 'initial',
          },
        ],
      })
      saveVersions(conversationId, migrated)
      return migrated
    }

    if (isPromptDraftVersion(parsed)) {
      return normalizeState({
        currentVersionId: parsed.id,
        versions: [parsed],
      })
    }

    clearStoredPromptDraft(conversationId)
    return null
  } catch {
    clearStoredPromptDraft(conversationId)
    return null
  }
}

function toVersion(
  draft: PromptDraftLocal,
  source: PromptDraftVersionSource,
  existingIds: Set<string>
): PromptDraftVersion {
  return {
    ...draft,
    id: createUniqueVersionId(existingIds),
    source,
  }
}

function saveVersions(conversationId: string | number, state: PromptDraftVersionsState): void {
  try {
    localStorage.setItem(getStorageKey(conversationId), JSON.stringify(normalizeState(state)))
  } catch {
    // Keep UI non-blocking when storage is unavailable.
  }
}

export function getPromptDraftVersions(
  conversationId: string | number
): PromptDraftVersionsState | null {
  return readPromptDraftVersions(conversationId)
}

export function savePromptDraftVersions(
  conversationId: string | number,
  state: PromptDraftVersionsState
): void {
  saveVersions(conversationId, state)
}

export function appendPromptDraftVersion(
  conversationId: string | number,
  draft: PromptDraftLocal,
  source: PromptDraftVersionSource = 'regenerate'
): PromptDraftVersionsState | null {
  const existing = readPromptDraftVersions(conversationId)
  const existingIds = new Set(existing?.versions.map(version => version.id))
  const nextVersion = toVersion(draft, existing ? source : 'initial', existingIds)
  const versions = existing ? [...existing.versions] : []

  versions.unshift(nextVersion)

  const nextState = normalizeState({
    currentVersionId: nextVersion.id,
    versions,
  })
  saveVersions(conversationId, nextState)
  return nextState
}

export function setCurrentPromptDraftVersion(
  conversationId: string | number,
  versionId: string
): PromptDraftVersionsState | null {
  const existing = readPromptDraftVersions(conversationId)
  if (!existing) return null

  const target = existing.versions.find(version => version.id === versionId)
  if (!target) return existing

  const nextState = normalizeState({
    currentVersionId: versionId,
    versions: [target, ...existing.versions.filter(version => version.id !== versionId)],
  })
  saveVersions(conversationId, nextState)
  return nextState
}

export function savePromptDraft(conversationId: string | number, draft: PromptDraftLocal): void {
  appendPromptDraftVersion(conversationId, draft)
}

export function getPromptDraft(conversationId: string | number): PromptDraftLocal | null {
  const state = readPromptDraftVersions(conversationId)
  const current = state?.versions.find(version => version.id === state.currentVersionId) ?? null
  if (!current) return null

  const { id: _id, source: _source, ...draft } = current
  return draft
}

export function clearPromptDraft(conversationId: string | number): void {
  try {
    localStorage.removeItem(getStorageKey(conversationId))
  } catch {
    // Keep UI non-blocking when storage is unavailable.
  }
}
