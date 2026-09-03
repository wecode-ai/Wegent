const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000

function parseBackendUTCDate(value: string): Date {
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`
  return new Date(normalized)
}

export function formatUTC8DateTime(value: string | null | undefined, fallback = '-'): string {
  if (!value) return fallback

  const date = parseBackendUTCDate(value)
  if (Number.isNaN(date.getTime())) return fallback

  const utc8Date = new Date(date.getTime() + UTC8_OFFSET_MS)
  const year = utc8Date.getUTCFullYear()
  const month = String(utc8Date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(utc8Date.getUTCDate()).padStart(2, '0')
  const hours = String(utc8Date.getUTCHours()).padStart(2, '0')
  const minutes = String(utc8Date.getUTCMinutes()).padStart(2, '0')
  const seconds = String(utc8Date.getUTCSeconds()).padStart(2, '0')

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}
