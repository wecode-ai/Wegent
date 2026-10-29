import type { CloudAuthorizationHandle } from '@/features/cloud-connection/CloudConnectionContext'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isHttpUrl, openExternalUrl } from './external-links'
import { isElectronRuntime } from './runtime-environment'

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
    return {
      closed: invokeDesktopHost<void>('auth.awaitConnectorAuthorization', { requestId }),
      close: () => invokeDesktopHost<void>('auth.closeConnectorAuthorization', { requestId }),
    }
  }

  await openExternalUrl(url, { target: 'system' })
}
