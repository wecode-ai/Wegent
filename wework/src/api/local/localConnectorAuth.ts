import { observeOperation } from '@/telemetry/observeOperation'
import { ensureLocalExecutorStarted, requestLocalExecutor } from '@/desktop/localExecutor'
import type { InstalledPluginComponents, PluginLocalAuthDefinition } from '@/types/api'
import { isOpenAiOfficialMarketplaceId } from '@/features/plugins/marketplaceIdentity'
import { GITHUB_CLI_TARGET, isGithubCliTarget } from './githubCli'

export type LocalConnectorAuthStatus =
  | 'ok'
  | 'preparing'
  | 'waiting_browser'
  | 'verifying'
  | 'need_login'
  | 'need_scan'
  | 'waiting_scan'
  | 'scanned'
  | 'expired'
  | 'cancelled'
  | 'error'

export interface LocalConnectorAuthResult {
  status: LocalConnectorAuthStatus
  rawStatus?: string | null
  hint?: string | null
  sid?: string | null
  qrPath?: string | null
  qrImage?: {
    mimeType?: string
    dataUrl?: string
    path?: string
  } | null
  title?: string | null
  finalUrl?: string | null
  sessionId?: string | null
  accountRevoked?: boolean
  connected?: boolean
  errorCode?: string
  verificationUrl?: string | null
  userCode?: string | null
}

export class LocalConnectorAuthLogoutError extends Error {
  readonly accountRevoked: boolean
  readonly errorCode?: string

  constructor(result: LocalConnectorAuthResult) {
    super('local_auth_logout_failed')
    this.name = 'LocalConnectorAuthLogoutError'
    this.accountRevoked = result.accountRevoked === true
    this.errorCode = result.errorCode
  }
}

export interface LocalConnectorAuthTarget {
  pluginKey: string
  connectorSlug: string
  localAuth?: PluginLocalAuthDefinition | null
  pluginRoot?: string | null
}

/** Resolve host-owned authentication without changing the cached plugin manifest. */
export function pluginLocalConnectorAuthTarget(
  pluginKey: string,
  marketplaceId: string,
  connector: NonNullable<InstalledPluginComponents['connectors']>[number]
): LocalConnectorAuthTarget | null {
  if (
    isOpenAiOfficialMarketplaceId(marketplaceId) &&
    pluginKey.toLowerCase() === 'github' &&
    connector.slug.toLowerCase() === 'github'
  ) {
    return GITHUB_CLI_TARGET
  }
  return isLocalConnector(connector)
    ? { pluginKey, connectorSlug: connector.slug, localAuth: connector.localAuth ?? null }
    : null
}

interface LocalConnectorAuthHealthOptions {
  bypassCache?: boolean
}

/** Short TTL so send preflight does not re-probe an already-healthy connector. */
const OK_HEALTH_TTL_MS = 120_000
const okHealthCache = new Map<string, number>()
let healthCacheRevision = 0

function healthCacheKey(target: LocalConnectorAuthTarget): string {
  return `${target.pluginKey.trim().toLowerCase()}::${target.connectorSlug.trim().toLowerCase()}`
}

export function clearLocalConnectorAuthHealthCache(): void {
  healthCacheRevision += 1
  okHealthCache.clear()
}

async function callLocalConnectorAuth(
  method: 'health' | 'start' | 'poll' | 'cancel' | 'logout',
  target: LocalConnectorAuthTarget,
  sessionId?: string | null
): Promise<LocalConnectorAuthResult> {
  await ensureLocalExecutorStarted()
  return requestLocalExecutor<LocalConnectorAuthResult>(`runtime.local_connector_auth.${method}`, {
    pluginKey: target.pluginKey,
    connectorSlug: target.connectorSlug,
    pluginRoot: target.pluginRoot ?? undefined,
    sessionId: sessionId ?? undefined,
  })
}

export function localConnectorAuthHealth(
  target: LocalConnectorAuthTarget,
  options: LocalConnectorAuthHealthOptions = {}
): Promise<LocalConnectorAuthResult> {
  const key = healthCacheKey(target)
  const revision = healthCacheRevision
  const cachedAt = okHealthCache.get(key)
  if (
    !isGithubCliTarget(target) &&
    !options.bypassCache &&
    cachedAt != null &&
    Date.now() - cachedAt < OK_HEALTH_TTL_MS
  ) {
    return Promise.resolve({ status: 'ok' as const satisfies LocalConnectorAuthStatus })
  }
  return callLocalConnectorAuth('health', target).then(result => {
    if (revision === healthCacheRevision) {
      if (result.status === 'ok' && !isGithubCliTarget(target)) okHealthCache.set(key, Date.now())
      else okHealthCache.delete(key)
    }
    return result
  })
}

export function localConnectorAuthStart(target: LocalConnectorAuthTarget) {
  return callLocalConnectorAuth('start', target)
}

export function localConnectorAuthPoll(
  target: LocalConnectorAuthTarget,
  sessionId?: string | null
) {
  return callLocalConnectorAuth('poll', target, sessionId)
}

export function localConnectorAuthCancel(target: LocalConnectorAuthTarget, sessionId: string) {
  return callLocalConnectorAuth('cancel', target, sessionId)
}

export function localConnectorAuthLogout(target: LocalConnectorAuthTarget) {
  healthCacheRevision += 1
  okHealthCache.delete(healthCacheKey(target))
  return observeOperation(
    'plugin.disconnect',
    async () => {
      const result = await callLocalConnectorAuth('logout', target)
      if (result?.status !== 'ok')
        throw new LocalConnectorAuthLogoutError(result ?? { status: 'error' })
      return result
    },
    result => result.status === 'ok'
  )
}

export function isLocalConnector(
  connector:
    | {
        authPolicy?: string
        localAuth?: PluginLocalAuthDefinition | null
      }
    | null
    | undefined
): boolean {
  return Boolean(connector?.localAuth?.kind || connector?.localAuth?.start?.length)
}

export function isLocalQrConnector(
  connector:
    | {
        localAuth?: PluginLocalAuthDefinition | null
      }
    | null
    | undefined
): boolean {
  return connector?.localAuth?.kind === 'local_qr'
}

export function isLocalBrowserConnector(
  connector:
    | {
        localAuth?: PluginLocalAuthDefinition | null
      }
    | null
    | undefined
): boolean {
  return connector?.localAuth?.kind === 'browser_oauth'
}

/** Decide manage-connection action from a local QR health probe. */
export function localQrManageActionFromHealth(
  health: LocalConnectorAuthResult | null | undefined
): 'logout' | 'login' {
  return health?.status === 'ok' ? 'logout' : 'login'
}

export function pollIntervalMs(localAuth?: PluginLocalAuthDefinition | null): number {
  const seconds = localAuth?.pollIntervalSeconds ?? 2
  return Math.max(1, Math.min(seconds, 30)) * 1000
}
