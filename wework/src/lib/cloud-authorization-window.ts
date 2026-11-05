import type { CloudAuthorizationHandle } from '@/features/cloud-connection/CloudConnectionContext'
import { invokeDesktopHost, subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import { isHttpUrl, openExternalUrl } from './external-links'
import { isElectronRuntime } from './runtime-environment'

export const CONNECTOR_AUTHORIZATION_CLOSED_EVENT = 'connectorAuthorization.closed'

/**
 * Open the connector consent page.
 *
 * The desktop keeps consent inside the app: leaving for the system browser
 * loses the user's place in the conversation and hides the flow from tests.
 * Web builds still hand the page to a normal browser tab.
 */
export async function openCloudAuthorizationWindow(
  url: string
): Promise<CloudAuthorizationHandle | void> {
  if (!isHttpUrl(url)) {
    return
  }

  if (isElectronRuntime()) {
    // One attempt owns one window. The poll loop decides when it can close;
    // closing is idempotent and scoped to this request id, so a failed or
    // cancelled attempt never closes another attempt's window.
    const requestId = crypto.randomUUID()
    await invokeDesktopHost<void>('auth.openConnectorAuthorization', { url, requestId })
    // The close arrives as a durable host event: waiting on one long-lived
    // request would end at the host's request timeout while the consent page
    // is still open, dropping the real close that follows.
    let settled = false
    let unsubscribe: () => void = () => undefined
    let resolveClosed: () => void = () => undefined
    const closed = new Promise<void>(resolve => {
      resolveClosed = () => {
        if (settled) return
        settled = true
        unsubscribe()
        resolve()
      }
    })
    const matches = (event: { type: string; payload: Record<string, unknown> }) =>
      event.type === CONNECTOR_AUTHORIZATION_CLOSED_EVENT && event.payload.requestId === requestId
    unsubscribe = subscribeDesktopHostEvents(
      event => {
        if (matches(event)) resolveClosed()
      },
      { replay: matches }
    )
    return {
      closed,
      // A missed notification costs one poll interval, not the whole session:
      // the host answers with the window's real state on demand.
      isOpen: async () => {
        const state = await invokeDesktopHost<{ open?: boolean }>(
          'auth.getConnectorAuthorizationState',
          { requestId }
        )
        return state?.open !== false
      },
      close: async () => {
        resolveClosed()
        await invokeDesktopHost<void>('auth.closeConnectorAuthorization', { requestId })
      },
    }
  }

  await openExternalUrl(url, { target: 'system' })
}
