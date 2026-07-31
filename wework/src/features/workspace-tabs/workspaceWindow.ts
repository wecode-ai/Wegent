import type { UnlistenFn } from '@tauri-apps/api/event'
import { LogicalPosition } from '@tauri-apps/api/dpi'
import { getPlatform } from '@/lib/platform'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { toBrowserPath } from '@/lib/navigation'
import { workspaceTabRoute, type WorkspaceTab } from './workspaceTabs'

const WINDOW_CREATION_TIMEOUT_MS = 10_000

function errorMessage(payload: unknown): string {
  if (payload instanceof Error) return payload.message
  return typeof payload === 'string' ? payload : 'Unknown Tauri window error'
}

export async function openWorkspaceTabWindow(tab: WorkspaceTab): Promise<void> {
  const route = toBrowserPath(workspaceTabRoute(tab))
  if (!isTauriRuntime()) {
    window.open(route, '_blank', 'noopener,noreferrer')
    return
  }

  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  const label = `workspace-${tab.id}-${Date.now()}`
  const platform = getPlatform()
  const workspaceWindow = new WebviewWindow(label, {
    url: route,
    title: tab.title,
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    center: true,
    focus: true,
    visible: false,
    resizable: true,
    transparent: platform === 'mac',
    decorations: platform !== 'win',
    titleBarStyle: platform === 'mac' ? 'overlay' : undefined,
    hiddenTitle: platform === 'mac',
    trafficLightPosition: platform === 'mac' ? new LogicalPosition(19, 21) : undefined,
    shadow: true,
    dragDropEnabled: false,
    tabbingIdentifier: platform === 'mac' ? 'io.wecode.wework.workspace' : undefined,
  })

  let settled = false
  const unlisten: UnlistenFn[] = []
  await new Promise<void>((resolve, reject) => {
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      unlisten.forEach(dispose => dispose())
      callback()
    }
    const timeout = window.setTimeout(() => {
      finish(() => reject(new Error('Timed out creating workspace window')))
    }, WINDOW_CREATION_TIMEOUT_MS)

    void workspaceWindow
      .once('tauri://created', () => finish(resolve))
      .then(dispose => unlisten.push(dispose))
      .catch(error => finish(() => reject(error)))
    void workspaceWindow
      .once('tauri://error', event => finish(() => reject(new Error(errorMessage(event.payload)))))
      .then(dispose => unlisten.push(dispose))
      .catch(error => finish(() => reject(error)))
  })

  await workspaceWindow.show()
  await workspaceWindow.setFocus()
}
