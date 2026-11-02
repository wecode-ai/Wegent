import { getTelemetryConfig } from './config'
import type { WeworkTelemetryContext } from './facts'

let emailPrefix: string | undefined

/** Retain only the selected account identifier, never additional account properties. */
export function setTelemetryUser(user: { id: number; email?: string | null } | null): void {
  emailPrefix = undefined
  if (
    getTelemetryConfig().identity !== 'email_prefix' ||
    !user ||
    !Number.isSafeInteger(user.id) ||
    user.id <= 0
  )
    return
  const email = typeof user.email === 'string' ? user.email.trim() : ''
  const separator = email.indexOf('@')
  const prefix = separator > 0 ? email.slice(0, separator) : ''
  if (/^[^\s@]{1,128}$/.test(prefix)) emailPrefix = prefix
}

function bounded(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256
    ? value.trim()
    : undefined
}

export function telemetryDistinctId(anonymousId: string): string {
  return getTelemetryConfig().identity === 'email_prefix' && emailPrefix ? emailPrefix : anonymousId
}

export function telemetryContextProperties(
  context?: WeworkTelemetryContext
): Record<string, unknown> {
  if (!context) return {}
  const candidates: Record<string, unknown> = {
    smart_app_key: bounded(context.smartApp?.key),
    smart_app_name: bounded(context.smartApp?.name),
    smart_app_version: bounded(context.smartApp?.version),
    smart_app_source: context.smartApp?.source,
    plugin_key: bounded(context.pluginInvocation?.pluginKey),
    plugin_marketplace: bounded(context.pluginInvocation?.marketplace),
    plugin_version: bounded(context.pluginInvocation?.version),
    tool_name: bounded(context.pluginInvocation?.toolName),
    tool_duration_ms: context.pluginInvocation?.durationMs,
  }
  return Object.fromEntries(
    getTelemetryConfig().contextFields.flatMap(field => {
      const value = candidates[field]
      if (value === undefined) return []
      if (
        field === 'tool_duration_ms' &&
        (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      )
        return []
      if (field === 'smart_app_source' && !['managed', 'linked', 'market'].includes(String(value)))
        return []
      return [[field, value]]
    })
  )
}

/** Bind durable records to the receiving project and its collection policy. */
export function telemetryDeliveryScope(): string {
  const config = getTelemetryConfig()
  return JSON.stringify([
    config.posthogHost,
    config.posthogKey,
    config.identity,
    [...config.contextFields].sort(),
    config.source,
  ])
}
