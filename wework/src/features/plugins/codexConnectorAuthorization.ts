import type { LocalDeviceApp, InstalledPluginComponents } from '@/types/api'
import type { LocalCodexPluginApi } from '@/api/local/codexPlugins'
import { raceWithTimeout } from '@/lib/promise-timeout'
import { remoteCatalogErrorKind } from './remotePluginError'

/** Return only localized error keys, never raw app-server HTML or credentials. */
export function codexAuthorizationErrorKey(error: unknown): string {
  const kind = remoteCatalogErrorKind(error)
  return {
    blocked: 'workbench.plugins_connector_auth_blocked',
    auth: 'workbench.plugins_connector_auth_account_required',
    timeout: 'workbench.plugins_connector_auth_timeout',
    failed: 'workbench.plugins_connector_auth_failed',
  }[kind]
}

export const CODEX_AUTHORIZATION_CATALOG_TIMEOUT_MS = 45_000

export class CodexAuthorizationTimeoutError extends Error {
  constructor() {
    super('Codex authorization catalog request timed out')
    this.name = 'CodexAuthorizationTimeoutError'
  }
}

/** Bound the whole catalog read, not each page; stop late pagination on timeout. */
export async function readCodexAuthorizationApps(
  listApps: LocalCodexPluginApi['listApps'],
  forceRefetch = false
): Promise<LocalDeviceApp[]> {
  const controller = new AbortController()
  try {
    return await raceWithTimeout(
      listApps({ includeInaccessible: true, forceRefetch, signal: controller.signal }),
      CODEX_AUTHORIZATION_CATALOG_TIMEOUT_MS,
      () => new CodexAuthorizationTimeoutError()
    )
  } finally {
    controller.abort()
  }
}

type Connector = NonNullable<InstalledPluginComponents['connectors']>[number]
const normalized = (value?: string | null) => value?.trim().toLowerCase() || ''

/** Resolve the selected connector, never an unrelated app from the same plugin. */
export function resolveCodexConnectorApp(
  apps: LocalDeviceApp[],
  connector: Connector,
  declaredApps: InstalledPluginComponents['apps'] = []
): LocalDeviceApp | null {
  const names = new Set(
    [connector.slug, connector.displayName, connector.authorizationGroup?.displayName]
      .map(normalized)
      .filter(Boolean)
  )
  const ids = new Set([
    normalized(connector.slug),
    ...declaredApps.filter(app => names.has(normalized(app.name))).map(app => normalized(app.path)),
  ])
  const exact = apps.filter(app => ids.has(normalized(app.id)))
  const matches = exact.length ? exact : apps.filter(app => names.has(normalized(app.name)))
  return matches.length === 1 ? matches[0] : null
}

/** Only use a live provider URL; do not invent OAuth URLs or store them in inventory. */
export function codexAppAuthorizationUrl(app: LocalDeviceApp): string | null {
  try {
    const url = new URL(app.installUrl || '')
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}
