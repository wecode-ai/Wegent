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
    // The capability resolves when the consent window closes, so hand the
    // caller a handle and let it keep polling while the user decides. The
    // poll loop closes the window once the backend reports a terminal state;
    // closing it earlier is the user cancelling.
    const closed = invokeDesktopHost<void>('auth.openConnectorAuthorization', { url })
    void closed.catch(() => undefined)
    return {
      closed,
      close: () => invokeDesktopHost<void>('auth.closeConnectorAuthorization'),
    }
  }

  await openExternalUrl(url, { target: 'system' })
}
