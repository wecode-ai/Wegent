export function normalizeTaskDescription(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const decoded = trimmed.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&nbsp;', ' ')
  return /^(?:<p>(?:\s|<br\s*\/?>)*<\/p>)+$/i.test(decoded) ? '' : value
}
