export type ImSourceRecord = {
  source?: unknown
  channel_label?: unknown
  channel_type?: unknown
}

export type ImSourceLike = string | ImSourceRecord | null | undefined

export function isRecord(value: unknown): value is ImSourceRecord {
  return typeof value === 'object' && value !== null
}

export function getTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function isIMSource(source: ImSourceLike): boolean {
  if (typeof source === 'string') return source === 'im'
  return isRecord(source) && source.source === 'im'
}
