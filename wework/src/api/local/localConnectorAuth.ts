import { ensureLocalExecutorStarted, requestLocalExecutor } from '@/tauri/localExecutor'
import type { PluginLocalAuthDefinition } from '@/types/api'

export type LocalConnectorAuthStatus =
  | 'ok'
  | 'need_login'
  | 'need_scan'
  | 'waiting_scan'
  | 'scanned'
  | 'expired'
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
}

export interface LocalConnectorAuthTarget {
  pluginKey: string
  connectorSlug: string
  localAuth?: PluginLocalAuthDefinition | null
  pluginRoot?: string | null
}

async function callLocalConnectorAuth(
  method: 'health' | 'start' | 'poll' | 'logout',
  target: LocalConnectorAuthTarget
): Promise<LocalConnectorAuthResult> {
  await ensureLocalExecutorStarted()
  return requestLocalExecutor<LocalConnectorAuthResult>(`runtime.local_connector_auth.${method}`, {
    pluginKey: target.pluginKey,
    connectorSlug: target.connectorSlug,
    pluginRoot: target.pluginRoot ?? undefined,
  })
}

export function localConnectorAuthHealth(target: LocalConnectorAuthTarget) {
  return callLocalConnectorAuth('health', target)
}

export function localConnectorAuthStart(target: LocalConnectorAuthTarget) {
  return callLocalConnectorAuth('start', target)
}

export function localConnectorAuthPoll(target: LocalConnectorAuthTarget) {
  return callLocalConnectorAuth('poll', target)
}

export function localConnectorAuthLogout(target: LocalConnectorAuthTarget) {
  return callLocalConnectorAuth('logout', target)
}

export function isLocalQrConnector(
  connector:
    | {
        authPolicy?: string
        localAuth?: PluginLocalAuthDefinition | null
      }
    | null
    | undefined
): boolean {
  return Boolean(connector?.localAuth?.kind === 'local_qr' || connector?.localAuth?.start?.length)
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
