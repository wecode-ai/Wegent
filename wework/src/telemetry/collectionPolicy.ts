export const TELEMETRY_CONTEXT_FIELDS = [
  'smart_app_key',
  'smart_app_name',
  'smart_app_version',
  'smart_app_source',
  'plugin_key',
  'plugin_marketplace',
  'plugin_version',
  'tool_name',
  'tool_duration_ms',
] as const
export type TelemetryContextField = (typeof TELEMETRY_CONTEXT_FIELDS)[number]

export function parseTelemetryIdentity(value: string): 'anonymous' | 'email_prefix' {
  const identity = value.trim() || 'anonymous'
  if (identity !== 'anonymous' && identity !== 'email_prefix')
    throw new Error('Invalid telemetry distinct ID source')
  return identity
}

export function parseTelemetryContextFields(value: string): TelemetryContextField[] {
  if (!value.trim()) return []
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.some(field => !TELEMETRY_CONTEXT_FIELDS.includes(field)))
    throw new Error('Invalid telemetry field policy: VITE_WEWORK_TELEMETRY_CONTEXT_FIELDS')
  return [...new Set(parsed)] as TelemetryContextField[]
}
