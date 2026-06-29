import type { TurnFileChangeItem, TurnFileChangesStatus, TurnFileChangesSummary } from '@/types/api'

const STATUSES = new Set<TurnFileChangesStatus>([
  'active',
  'reverted',
  'conflicted',
  'artifact_missing',
])
const CHANGE_TYPES = new Set<TurnFileChangeItem['change_type']>([
  'created',
  'modified',
  'deleted',
  'renamed',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0
}

function normalizeFile(value: unknown): TurnFileChangeItem | null {
  if (!isRecord(value)) return null
  if (
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    typeof value.change_type !== 'string' ||
    !CHANGE_TYPES.has(value.change_type as TurnFileChangeItem['change_type']) ||
    !isNonNegativeInteger(value.additions) ||
    !isNonNegativeInteger(value.deletions) ||
    typeof value.binary !== 'boolean'
  ) {
    return null
  }
  if (
    value.old_path !== undefined &&
    value.old_path !== null &&
    typeof value.old_path !== 'string'
  ) {
    return null
  }

  return {
    old_path: value.old_path as string | null | undefined,
    path: value.path,
    change_type: value.change_type as TurnFileChangeItem['change_type'],
    additions: value.additions,
    deletions: value.deletions,
    binary: value.binary,
  }
}

export function normalizeTurnFileChanges(value: unknown): TurnFileChangesSummary | undefined {
  if (!isRecord(value) || !Array.isArray(value.files)) return undefined
  if (
    value.version !== 1 ||
    typeof value.status !== 'string' ||
    !STATUSES.has(value.status as TurnFileChangesStatus) ||
    typeof value.artifact_id !== 'string' ||
    value.artifact_id.length === 0 ||
    typeof value.device_id !== 'string' ||
    value.device_id.length === 0 ||
    typeof value.workspace_path !== 'string' ||
    value.workspace_path.length === 0 ||
    !isNonNegativeInteger(value.file_count) ||
    !isNonNegativeInteger(value.additions) ||
    !isNonNegativeInteger(value.deletions)
  ) {
    return undefined
  }

  const files = value.files.map(normalizeFile)
  if (files.some(file => file === null) || files.length !== value.file_count) {
    return undefined
  }
  if (
    value.reverted_at !== undefined &&
    value.reverted_at !== null &&
    typeof value.reverted_at !== 'string'
  ) {
    return undefined
  }

  return {
    version: 1,
    status: value.status as TurnFileChangesStatus,
    artifact_id: value.artifact_id,
    device_id: value.device_id,
    workspace_path: value.workspace_path,
    file_count: value.file_count,
    additions: value.additions,
    deletions: value.deletions,
    files: files as TurnFileChangeItem[],
    reverted_at: value.reverted_at as string | null | undefined,
    diff: typeof value.diff === 'string' ? value.diff : undefined,
    revertible: typeof value.revertible === 'boolean' ? value.revertible : undefined,
  }
}
