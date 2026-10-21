// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { adminApis } from '@/apis/admin'

export const CONNECTOR_AUTHORIZATION_CHANGED_EVENT = 'wegent:connector-authorization-changed'

/** Same-origin placeholder shown until the consent URL is known. */
export const CONNECTOR_OAUTH_PENDING_PATH = '/mcp-oauth-pending.html'

export type ConnectorOAuthErrorCode = 'popup_blocked' | 'declined' | 'failed' | 'timeout'

export class ConnectorOAuthError extends Error {
  constructor(
    readonly code: ConnectorOAuthErrorCode,
    message?: string
  ) {
    super(message || code)
    this.name = 'ConnectorOAuthError'
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

/**
 * Run the authorization-code flow for one connector app: create the session,
 * open the provider consent page, and poll until the backend stores the token.
 */
export async function authorizeConnectorApp(slug: string): Promise<void> {
  // Open the window while the click still counts as user activation: session
  // creation performs discovery and client registration first. A same-origin
  // placeholder keeps the popup valid until the consent URL is known.
  // `window.open(..., 'noopener')` returns null in Chrome even though the
  // window opens, so clear `opener` explicitly instead.
  const authorizationWindow = window.open(CONNECTOR_OAUTH_PENDING_PATH, '_blank')
  if (authorizationWindow) authorizationWindow.opener = null

  let session
  try {
    session = await adminApis.createConnectorOAuthSession(slug)
  } catch (error) {
    authorizationWindow?.close()
    throw error
  }

  if (authorizationWindow && !authorizationWindow.closed) {
    authorizationWindow.location.replace(session.authorize_url)
  } else {
    const fallback = window.open(session.authorize_url, '_blank')
    if (!fallback) {
      throw new ConnectorOAuthError('popup_blocked')
    }
    fallback.opener = null
  }

  const intervalMs = Math.max(500, session.poll_interval_seconds * 1000)
  const deadline = session.expires_at * 1000
  while (Date.now() < deadline) {
    await delay(intervalMs)
    const result = await adminApis.pollConnectorOAuthSession(session.session_id, session.poll_token)
    if (result.status === 'pending') continue
    if (result.status === 'success') {
      window.dispatchEvent(new CustomEvent(CONNECTOR_AUTHORIZATION_CHANGED_EVENT))
      return
    }
    if (result.status === 'declined') {
      throw new ConnectorOAuthError('declined')
    }
    throw new ConnectorOAuthError('failed', result.error || undefined)
  }
  throw new ConnectorOAuthError('timeout')
}

/** Map a flow failure onto the shared i18n keys of the connector card. */
export function connectorOAuthErrorMessage(
  t: (key: string, params?: Record<string, unknown>) => string,
  error: unknown
): string {
  if (error instanceof ConnectorOAuthError) {
    const keyByCode: Record<ConnectorOAuthErrorCode, string> = {
      popup_blocked: 'common:integrations.connector_apps.popup_blocked',
      declined: 'common:integrations.connector_apps.authorization_declined',
      failed: 'common:integrations.connector_apps.authorization_failed',
      timeout: 'common:integrations.connector_apps.authorization_timeout',
    }
    return error.code === 'failed' && error.message !== 'failed'
      ? error.message
      : t(keyByCode[error.code])
  }
  return error instanceof Error ? error.message : String(error)
}
