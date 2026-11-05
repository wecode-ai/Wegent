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

/** Thrown when the attempt owning a synchronization is no longer current. */
export class ConnectorSyncAbortedError extends Error {
  constructor() {
    super('Connector synchronization was superseded')
    this.name = 'ConnectorSyncAbortedError'
  }
}

/**
 * Push the cloud connector catalog into the local executor.
 *
 * Resolving means the executor has finished applying the app list, so callers
 * can treat it as the barrier between "authorization stored in the cloud" and
 * "the local runtime can actually call the connector's tools".
 *
 * The caller allocates the revision before its first await and passes
 * `isCurrent`, which every stage re-checks. A synchronization that lost its
 * account, backend or connection while a request was in flight must neither
 * publish the old catalog nor allocate a revision newer than the `clear` that
 * already ran: the executor compares revisions, so a late attempt would
 * otherwise undo a logout.
 */
export async function synchronizeConnectorApps({
  apiBaseUrl,
  token,
  requestedAtMs = Date.now(),
  syncRevision = nextConnectorSyncRevision(),
  onConfigured,
  isCurrent,
}: {
  apiBaseUrl: string
  token: string
  /** When the caller started the attempt; keeps the deadline off clock drift. */
  requestedAtMs?: number
  /** Revision allocated when the attempt started; never regenerated later. */
  syncRevision?: number
  /** Called once the runtime accepted the connector token. */
  onConfigured?: (deadline: ConnectorTokenDeadline) => void
  /**
   * False once the attempt no longer owns the current account/connection.
   * Required so every caller (bridge, authorization card) is bound to the
   * lifecycle that started it.
   */
  isCurrent: () => boolean
}): Promise<ConnectorAppSyncResult> {
  const checkCurrent = () => {
    if (!isCurrent()) throw new ConnectorSyncAbortedError()
  }
  checkCurrent()
  const connectorToken = await issueWegentConnectorToken(apiBaseUrl, token)
  checkCurrent()
  const expiresAtMs = requestedAtMs + connectorToken.expires_in * 1_000
  await requestLocalExecutor('runtime.connectors.configure', {
    apiBaseUrl,
    connectorToken: connectorToken.access_token,
    expiresAtMs,
    syncRevision,
  })
  checkCurrent()
  onConfigured?.({ expiresAtMs, expiresInSeconds: connectorToken.expires_in })
  const installed = await listWegentInstalledConnectorApps(apiBaseUrl, token)
  checkCurrent()
  // Guidance for unauthorized apps is additive: a catalog failure must not
  // stop the authorized apps from syncing.
  const catalog = await listWegentConnectorApps(apiBaseUrl, token).catch(() => [])
  checkCurrent()
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
  checkCurrent()
  return {
    changed: Boolean(result.changed),
    callableSlugs: [...callableSlugs],
    expiresAtMs,
    expiresInSeconds: connectorToken.expires_in,
  }
}

/**
 * Wait until the local executor has applied this connector as callable.
 *
 * The cloud grant and the runtime catalog converge separately, so a single
 * sync can still run before the backend exposes the app as callable. Retrying
 * inside a bounded window keeps the resume barrier intact without turning a
 * slow convergence into a permanent failure; after the deadline the caller
 * must keep its retry affordance and leave the conversation paused.
 */
export async function waitForLocalConnectorSync({
  apiBaseUrl,
  token,
  slug,
  isCurrent,
  timeoutMs = 30_000,
  intervalMs = 1_000,
}: {
  apiBaseUrl: string
  token: string
  slug: string
  /**
   * Lifecycle of the authorization attempt this wait belongs to.
   *
   * Every retry reuses one attempt-scoped revision and re-checks this guard, so
   * a retry that outlives a sign-out can neither configure the old account with
   * a newer revision than the `clear` that ran nor report success.
   */
  isCurrent: () => boolean
  timeoutMs?: number
  intervalMs?: number
}): Promise<boolean> {
  const syncRevision = nextConnectorSyncRevision()
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (!isCurrent()) throw new ConnectorSyncAbortedError()
    try {
      const result = await synchronizeConnectorApps({
        apiBaseUrl,
        token,
        syncRevision,
        isCurrent,
      })
      if (result.callableSlugs.includes(slug)) return true
    } catch (error) {
      // A superseded attempt must stop, never fall into the retry interval.
      if (error instanceof ConnectorSyncAbortedError) throw error
      // The reason is reported by the next successful attempt or by the
      // caller's timeout message; the card stays retryable either way.
    }
    if (!isCurrent()) throw new ConnectorSyncAbortedError()
    if (Date.now() >= deadline) return false
    await new Promise(resolve => window.setTimeout(resolve, intervalMs))
  }
}
