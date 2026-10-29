import {
  issueWegentConnectorToken,
  listWegentConnectorApps,
  listWegentInstalledConnectorApps,
} from '@/api/cloud/connectorApps'
import { requestLocalExecutor } from '@/desktop/localExecutor'
import { nextConnectorSyncRevision } from './connectorSyncRevision'

export interface ConnectorAppSyncResult {
  /** Whether the local executor's connector surface changed. */
  changed: boolean
  /** Slugs the local executor now exposes as callable connectors. */
  callableSlugs: string[]
  /** Wall-clock deadline of the connector token this synchronization used. */
  expiresAtMs: number
  /** Lifetime of the connector token used for this synchronization. */
  expiresInSeconds: number
}

export interface ConnectorTokenDeadline {
  expiresAtMs: number
  expiresInSeconds: number
}

/**
 * Push the cloud connector catalog into the local executor.
 *
 * Resolving means the executor has finished applying the app list, so callers
 * can treat it as the barrier between "authorization stored in the cloud" and
 * "the local runtime can actually call the connector's tools".
 */
export async function synchronizeConnectorApps({
  apiBaseUrl,
  token,
  requestedAtMs = Date.now(),
  onConfigured,
}: {
  apiBaseUrl: string
  token: string
  /** When the caller started the attempt; keeps the deadline off clock drift. */
  requestedAtMs?: number
  /** Called once the runtime accepted the connector token. */
  onConfigured?: (deadline: ConnectorTokenDeadline) => void
}): Promise<ConnectorAppSyncResult> {
  const connectorToken = await issueWegentConnectorToken(apiBaseUrl, token)
  const expiresAtMs = requestedAtMs + connectorToken.expires_in * 1_000
  await requestLocalExecutor('runtime.connectors.configure', {
    apiBaseUrl,
    connectorToken: connectorToken.access_token,
    expiresAtMs,
    syncRevision: nextConnectorSyncRevision(),
  })
  onConfigured?.({ expiresAtMs, expiresInSeconds: connectorToken.expires_in })
  const installed = await listWegentInstalledConnectorApps(apiBaseUrl, token)
  // Guidance for unauthorized apps is additive: a catalog failure must not
  // stop the authorized apps from syncing.
  const catalog = await listWegentConnectorApps(apiBaseUrl, token).catch(() => [])
  const callable = installed.apps
    .filter(app => app.enabled && app.callable)
    .map(app => ({
      slug: app.slug,
      name: app.runtime_name ?? app.slug,
      description: app.description ?? '',
      tools: app.tool_summaries ?? [],
      authorizationRequired: false,
    }))
  // Unauthorized apps still get a Skill so the agent knows the capability
  // exists and asks the user to authorize instead of denying it.
  const callableSlugs = new Set(callable.map(app => app.slug))
  const awaitingAuthorization = catalog
    .filter(
      app =>
        app.auth_type === 'oauth2' &&
        app.connection.status !== 'connected' &&
        !callableSlugs.has(app.slug)
    )
    .map(app => ({
      slug: app.slug,
      name: app.name,
      description: app.description ?? '',
      tools: [],
      authorizationRequired: true,
    }))
  const result = await requestLocalExecutor<{ changed: boolean }>('runtime.connectors.apps.sync', {
    apps: [...callable, ...awaitingAuthorization],
  })
  return {
    changed: Boolean(result.changed),
    callableSlugs: [...callableSlugs],
    expiresAtMs,
    expiresInSeconds: connectorToken.expires_in,
  }
}
