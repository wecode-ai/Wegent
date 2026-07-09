import type { UnlistenFn } from '@tauri-apps/api/event'
import type { CloudAuthorizationHandle } from '@/features/cloud-connection/CloudConnectionContext'
import { isHttpUrl, openExternalUrl } from './external-links'
import { isTauriRuntime } from './runtime-environment'

const CLOUD_AUTHORIZATION_WINDOW_LABEL = 'cloud-authorization'
const CLOUD_AUTHORIZATION_WINDOW_TITLE = 'Wegent Cloud'
const WINDOW_CREATION_TIMEOUT_MS = 10_000
const AUTHORIZATION_WINDOW_WIDTH = 520
const AUTHORIZATION_WINDOW_HEIGHT = 560
const AUTHORIZATION_WINDOW_MIN_WIDTH = 440
const AUTHORIZATION_WINDOW_MIN_HEIGHT = 500
const AUTHORIZATION_WINDOW_VERTICAL_OFFSET = -36

interface AuthorizationWindowPosition {
  x?: number
  y?: number
  center: boolean
}

interface TauriWebviewWindowHandle {
  close: () => Promise<void>
  destroy: () => Promise<void>
  setFocus: () => Promise<void>
  onCloseRequested: (handler: () => void | Promise<void>) => Promise<UnlistenFn>
  once: <T = unknown>(
    event: string,
    handler: (event: { payload: T }) => void
  ) => Promise<UnlistenFn>
}

async function closeAuthorizationWindow(windowHandle: TauriWebviewWindowHandle): Promise<void> {
  try {
    await windowHandle.close()
  } catch (closeError) {
    console.warn(
      '[CloudConnection] Failed to close authorization window, destroying it',
      closeError
    )
    await windowHandle.destroy().catch(destroyError => {
      console.error('[CloudConnection] Failed to destroy authorization window', destroyError)
    })
  }
}

function createCloseHandle(windowHandle: TauriWebviewWindowHandle): CloudAuthorizationHandle {
  let resolveClosed: () => void = () => undefined
  const closed = new Promise<void>(resolve => {
    resolveClosed = resolve
  })

  void windowHandle
    .onCloseRequested(() => resolveClosed())
    .catch(error => {
      console.error('[CloudConnection] Failed to listen for authorization window close', error)
    })

  return {
    closed,
    close: () => closeAuthorizationWindow(windowHandle),
  }
}

function formatTauriError(payload: unknown): string {
  if (payload instanceof Error) return payload.message
  if (typeof payload === 'string') return payload
  return 'Unknown Tauri window error'
}

async function getAuthorizationWindowPosition(): Promise<AuthorizationWindowPosition> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const currentWindow = getCurrentWindow()
    const [position, size, scaleFactor] = await Promise.all([
      currentWindow.outerPosition(),
      currentWindow.outerSize(),
      currentWindow.scaleFactor(),
    ])
    const width = AUTHORIZATION_WINDOW_WIDTH * scaleFactor
    const height = AUTHORIZATION_WINDOW_HEIGHT * scaleFactor
    return {
      x: Math.max(0, Math.round((position.x + (size.width - width) / 2) / scaleFactor)),
      y: Math.max(
        0,
        Math.round(
          (position.y + (size.height - height) / 2) / scaleFactor +
            AUTHORIZATION_WINDOW_VERTICAL_OFFSET
        )
      ),
      center: false,
    }
  } catch (error) {
    console.warn('[CloudConnection] Failed to position authorization window', error)
    return { center: true }
  }
}

async function waitForWindowCreation(windowHandle: TauriWebviewWindowHandle): Promise<void> {
  let settled = false
  const unlistenFns: UnlistenFn[] = []

  return new Promise((resolve, reject) => {
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeoutId)
      unlistenFns.forEach(unlisten => unlisten())
      callback()
    }

    const timeoutId = window.setTimeout(() => {
      finish(() => reject(new Error('Timed out creating cloud authorization window')))
    }, WINDOW_CREATION_TIMEOUT_MS)

    void windowHandle
      .once('tauri://created', () => finish(resolve))
      .then(unlisten => unlistenFns.push(unlisten))
      .catch(error => finish(() => reject(error)))

    void windowHandle
      .once('tauri://error', event => {
        finish(() => reject(new Error(formatTauriError(event.payload))))
      })
      .then(unlisten => unlistenFns.push(unlisten))
      .catch(error => finish(() => reject(error)))
  })
}

export async function openCloudAuthorizationWindow(
  url: string
): Promise<CloudAuthorizationHandle | void> {
  if (!isHttpUrl(url)) {
    return
  }

  if (!isTauriRuntime()) {
    await openExternalUrl(url)
    return
  }

  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  const existingWindow = await WebviewWindow.getByLabel(CLOUD_AUTHORIZATION_WINDOW_LABEL)
  if (existingWindow) {
    await existingWindow.close().catch(() => undefined)
  }

  const position = await getAuthorizationWindowPosition()
  const authWindow = new WebviewWindow(CLOUD_AUTHORIZATION_WINDOW_LABEL, {
    url,
    title: CLOUD_AUTHORIZATION_WINDOW_TITLE,
    width: AUTHORIZATION_WINDOW_WIDTH,
    height: AUTHORIZATION_WINDOW_HEIGHT,
    minWidth: AUTHORIZATION_WINDOW_MIN_WIDTH,
    minHeight: AUTHORIZATION_WINDOW_MIN_HEIGHT,
    ...position,
    preventOverflow: true,
    resizable: true,
    maximizable: false,
    focus: true,
    visible: true,
    decorations: true,
    shadow: true,
    dragDropEnabled: false,
  })

  await waitForWindowCreation(authWindow)
  await authWindow.setFocus().catch(() => undefined)
  return createCloseHandle(authWindow)
}
