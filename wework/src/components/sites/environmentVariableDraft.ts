import type {
  EnvironmentPatchOperation,
  EnvironmentSnapshot,
  EnvironmentVariableType,
} from '@/api/sites'

export interface EnvironmentVariableDraft {
  id: string
  sourceKey: string | null
  key: string
  type: EnvironmentVariableType
  value: string
  originalValue: string | null
  valueChanged: boolean
  secretConfigured: boolean
}

export function createEnvironmentDraft(snapshot: EnvironmentSnapshot): EnvironmentVariableDraft[] {
  return snapshot.items.map((item, index) => ({
    id: `${item.key}-${index}`,
    sourceKey: item.key,
    key: item.key,
    type: item.type,
    value: item.type === 'plain' ? item.value : '',
    originalValue: item.type === 'plain' ? item.value : null,
    valueChanged: false,
    secretConfigured: item.type === 'secret' && item.configured,
  }))
}

export function createEmptyEnvironmentDraft(id: string): EnvironmentVariableDraft {
  return {
    id,
    sourceKey: null,
    key: '',
    type: 'plain',
    value: '',
    originalValue: null,
    valueChanged: false,
    secretConfigured: false,
  }
}

export function validateEnvironmentDraft(rows: EnvironmentVariableDraft[]): string | null {
  const keys = new Set<string>()
  for (const row of rows) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(row.key)) return 'invalid_key'
    if (row.key.startsWith('WEGENT_')) return 'reserved_key'
    if (keys.has(row.key)) return 'duplicate_key'
    keys.add(row.key)
    if (row.type === 'secret' && !row.secretConfigured && (!row.valueChanged || row.value === '')) {
      return 'secret_value_required'
    }
  }
  return null
}

export function buildEnvironmentPatchOperations(
  original: EnvironmentSnapshot,
  rows: EnvironmentVariableDraft[]
): EnvironmentPatchOperation[] {
  const operations: EnvironmentPatchOperation[] = []
  const retainedSourceKeys = new Set(rows.flatMap(row => (row.sourceKey ? [row.sourceKey] : [])))

  for (const item of original.items) {
    if (!retainedSourceKeys.has(item.key)) operations.push({ op: 'remove', key: item.key })
  }

  for (const row of rows) {
    if (row.sourceKey && row.sourceKey !== row.key) {
      operations.push({ op: 'remove', key: row.sourceKey })
    }
    const originalItem = row.sourceKey
      ? original.items.find(item => item.key === row.sourceKey)
      : undefined
    const unchangedSecret =
      originalItem?.type === 'secret' &&
      row.type === 'secret' &&
      row.sourceKey === row.key &&
      !row.valueChanged
    const unchangedPlain =
      originalItem?.type === 'plain' &&
      row.type === 'plain' &&
      row.sourceKey === row.key &&
      row.value === row.originalValue
    if (unchangedSecret || unchangedPlain) continue
    operations.push({ op: 'upsert', key: row.key, type: row.type, value: row.value })
  }

  return operations
}
