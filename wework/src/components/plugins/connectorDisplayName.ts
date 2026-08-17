const CONNECTOR_DISPLAY_NAMES: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  gmail: 'Gmail',
  slack: 'Slack',
  notion: 'Notion',
  linear: 'Linear',
  jira: 'Jira',
}

/** OpenAI / remote connector registries often use opaque ids instead of slugs. */
export function isOpaqueConnectorId(slug: string): boolean {
  const normalized = slug.trim().toLowerCase()
  if (!normalized) return true
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalized)) {
    return true
  }
  // Long hex tokens such as `2128aebfecb84f64a069897515042a44`.
  if (/^[0-9a-f]{16,}$/i.test(normalized)) return true
  return false
}

/**
 * Human label for an install/auth connector.
 * Prefer known slug maps / connector-app names; never surface opaque ids in UI.
 */
export function connectorDisplayName(
  slug: string,
  options?: {
    appName?: string | null
    pluginName?: string | null
  }
): string {
  const appName = options?.appName?.trim()
  if (appName) return appName

  const normalized = slug.trim().toLowerCase()
  if (CONNECTOR_DISPLAY_NAMES[normalized]) return CONNECTOR_DISPLAY_NAMES[normalized]

  const pluginName = options?.pluginName?.trim()
  if (isOpaqueConnectorId(normalized)) {
    return pluginName || ''
  }

  return slug
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => `${part.charAt(0).toLocaleUpperCase()}${part.slice(1)}`)
    .join(' ')
}
