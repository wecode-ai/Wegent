import { invoke } from '@tauri-apps/api/core'
import type { UnlistenFn } from '@tauri-apps/api/event'
import {
  currentMonitor,
  getCurrentWindow,
  primaryMonitor,
  type Monitor,
} from '@tauri-apps/api/window'
import type { CloudAuthorizationHandle } from '@/features/cloud-connection/CloudConnectionContext'
import { isHttpUrl, openExternalUrl } from './external-links'
import { isTauriRuntime } from './runtime-environment'

const CLOUD_AUTHORIZATION_WINDOW_LABEL = 'cloud-authorization'
const CLOUD_AUTHORIZATION_WINDOW_TITLE = 'Wegent Cloud'
const WINDOW_CREATION_TIMEOUT_MS = 10_000
const AUTHORIZATION_WINDOW_WIDTH = 1000
const AUTHORIZATION_WINDOW_HEIGHT = 640
const AUTHORIZATION_WINDOW_MIN_WIDTH = 960
const AUTHORIZATION_WINDOW_MIN_HEIGHT = 620
const AUTHORIZATION_WINDOW_VERTICAL_OFFSET = -36
const AUTHORIZATION_WINDOW_REPOSITION_DELAY_MS = 100

interface AuthorizationWindowPosition {
  x?: number
  y?: number
  center: boolean
}

interface TauriWebviewWindowHandle {
  close: () => Promise<void>
  destroy: () => Promise<void>
  show: () => Promise<void>
  setFocus: () => Promise<void>
  setAlwaysOnTop: (alwaysOnTop: boolean) => Promise<void>
  onCloseRequested: (handler: () => void | Promise<void>) => Promise<UnlistenFn>
  once: <T = unknown>(
    event: string,
    handler: (event: { payload: T }) => void
  ) => Promise<UnlistenFn>
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

function authorizationWindowPhysicalPosition(
  position: { x: number; y: number },
  size: { width: number; height: number },
  authorizationWindowSize: { width: number; height: number },
  monitor: Monitor,
  centerOnMonitor: boolean
): { x: number; y: number } {
  const scaleFactor = monitor.scaleFactor > 0 ? monitor.scaleFactor : 1
  const workArea = monitor.workArea
  const workAreaRight = workArea.position.x + workArea.size.width
  const workAreaBottom = workArea.position.y + workArea.size.height
  const maximumX = Math.max(workArea.position.x, workAreaRight - authorizationWindowSize.width)
  const maximumY = Math.max(workArea.position.y, workAreaBottom - authorizationWindowSize.height)
  const desiredX = centerOnMonitor
    ? workArea.position.x + (workArea.size.width - authorizationWindowSize.width) / 2
    : position.x + (size.width - authorizationWindowSize.width) / 2
  const desiredY =
    (centerOnMonitor
      ? workArea.position.y + (workArea.size.height - authorizationWindowSize.height) / 2
      : position.y + (size.height - authorizationWindowSize.height) / 2) +
    AUTHORIZATION_WINDOW_VERTICAL_OFFSET * scaleFactor

  return {
    x: Math.round(clamp(desiredX, workArea.position.x, maximumX)),
    y: Math.round(clamp(desiredY, workArea.position.y, maximumY)),
  }
}

function positionAuthorizationWindow(
  position: { x: number; y: number },
  size: { width: number; height: number },
  monitor: Monitor,
  centerOnMonitor: boolean
): AuthorizationWindowPosition {
  const scaleFactor = monitor.scaleFactor > 0 ? monitor.scaleFactor : 1
  const physicalPosition = authorizationWindowPhysicalPosition(
    position,
    size,
    {
      width: AUTHORIZATION_WINDOW_WIDTH * scaleFactor,
      height: AUTHORIZATION_WINDOW_HEIGHT * scaleFactor,
    },
    monitor,
    centerOnMonitor
  )
  return {
    x: Math.round(physicalPosition.x / scaleFactor),
    y: Math.round(physicalPosition.y / scaleFactor),
    center: false,
  }
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

async function followCurrentWeworkWindow(
  currentWindow: ReturnType<typeof getCurrentWindow>
): Promise<() => void> {
  let repositionTimeoutId: number | null = null
  const reposition = () => {
    if (repositionTimeoutId !== null) window.clearTimeout(repositionTimeoutId)
    repositionTimeoutId = window.setTimeout(() => {
      repositionTimeoutId = null
      void invoke('position_cloud_authorization_window').catch(error => {
        console.error('[CloudConnection] Failed to follow the Wework window', error)
      })
    }, AUTHORIZATION_WINDOW_REPOSITION_DELAY_MS)
  }
  const unlistenMoved = await currentWindow.onMoved(reposition)
  let unlistenScaleChanged: UnlistenFn
  try {
    unlistenScaleChanged = await currentWindow.onScaleChanged(reposition)
  } catch (error) {
    unlistenMoved()
    throw error
  }

  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    if (repositionTimeoutId !== null) window.clearTimeout(repositionTimeoutId)
    unlistenMoved()
    unlistenScaleChanged()
  }
}

function createCloseHandle(
  windowHandle: TauriWebviewWindowHandle,
  stopFollowing: () => void
): CloudAuthorizationHandle {
  let resolveClosed: () => void = () => undefined
  const closed = new Promise<void>(resolve => {
    resolveClosed = resolve
  })

  void windowHandle
    .onCloseRequested(() => {
      stopFollowing()
      resolveClosed()
    })
    .catch(error => {
      console.error('[CloudConnection] Failed to listen for authorization window close', error)
    })

  return {
    closed,
    close: async () => {
      stopFollowing()
      await closeAuthorizationWindow(windowHandle)
    },
  }
}

function formatTauriError(payload: unknown): string {
  if (payload instanceof Error) return payload.message
  if (typeof payload === 'string') return payload
  return 'Unknown Tauri window error'
}

async function getAuthorizationWindowPosition(
  currentWindow: ReturnType<typeof getCurrentWindow>
): Promise<AuthorizationWindowPosition> {
  try {
    const [position, size, activeMonitor] = await Promise.all([
      currentWindow.outerPosition(),
      currentWindow.outerSize(),
      currentMonitor(),
    ])
    const monitor = activeMonitor ?? (await primaryMonitor())
    if (!monitor) return { center: true }
    return positionAuthorizationWindow(position, size, monitor, activeMonitor === null)
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

  const currentWindow = getCurrentWindow()
  const position = await getAuthorizationWindowPosition(currentWindow)
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
    alwaysOnTop: true,
    focus: true,
    visible: false,
    decorations: true,
    shadow: true,
    dragDropEnabled: false,
  })

  await waitForWindowCreation(authWindow)
  const stopFollowing = await (async () => {
    try {
      await authWindow.setAlwaysOnTop(true)
      await invoke('position_cloud_authorization_window')
      await authWindow.show()
      return await followCurrentWeworkWindow(currentWindow)
    } catch (error) {
      await closeAuthorizationWindow(authWindow)
      throw error
    }
  })()
  await authWindow.setFocus().catch(() => undefined)
  return createCloseHandle(authWindow, stopFollowing)
}
