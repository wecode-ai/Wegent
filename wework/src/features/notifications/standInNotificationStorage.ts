export const STAND_IN_RECORD_LIMIT = 1000
export const STAND_IN_RECORD_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

export interface StandInRecord {
  version: string
  savedAt: number
}
export type StandInRecords = Record<string, StandInRecord>

function pruneRecords(value: unknown, now: number): StandInRecords {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, StandInRecord] => {
        const record = entry[1] as Partial<StandInRecord> | null
        return Boolean(
          record &&
          typeof record.version === 'string' &&
          typeof record.savedAt === 'number' &&
          record.savedAt <= now &&
          record.savedAt > now - STAND_IN_RECORD_MAX_AGE_MS
        )
      })
      .sort((a, b) => b[1].savedAt - a[1].savedAt)
      .slice(0, STAND_IN_RECORD_LIMIT)
  )
}

export function readStandInRecords(key: string, now = Date.now()): StandInRecords {
  const raw = localStorage.getItem(key)
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    localStorage.removeItem(key)
    return {}
  }
  const records = pruneRecords(parsed, now)
  localStorage.setItem(key, JSON.stringify(records))
  return records
}

export function writeStandInRecords(
  key: string,
  records: StandInRecords,
  now = Date.now()
): StandInRecords {
  const pruned = pruneRecords(records, now)
  localStorage.setItem(key, JSON.stringify(pruned))
  return pruned
}

export function createStandInRecordStore(key: string) {
  let snapshot = readStandInRecords(key)
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      const onStorage = (event: StorageEvent) => {
        if (event.key !== key && event.key !== null) return
        snapshot = readStandInRecords(key)
        listener()
      }
      window.addEventListener('storage', onStorage)
      return () => {
        listeners.delete(listener)
        window.removeEventListener('storage', onStorage)
      }
    },
    write(records: StandInRecords) {
      const next = writeStandInRecords(key, records)
      if (JSON.stringify(next) === JSON.stringify(snapshot)) return
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}
