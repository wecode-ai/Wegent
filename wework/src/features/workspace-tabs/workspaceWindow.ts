import type { UnlistenFn } from '@tauri-apps/api/event'
import { LogicalPosition } from '@tauri-apps/api/dpi'
import { getPlatform } from '@/lib/platform'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { toBrowserPath } from '@/lib/navigation'
import { disposeTauriListener } from '@/tauri/disposeTauriListener'
import {
  persistWorkspaceTabs,
  workspaceTabRoute,
  workspaceTabsStorageKey,
  type WorkspaceTab,
} from './workspaceTabs'
import { clearStagedWorkspaceTabTransfer, stageWorkspaceTabTransfer } from './workspaceTabTransfer'

const WINDOW_CREATION_TIMEOUT_MS = 10_000

function errorMessage(payload: unknown): string {
  if (payload instanceof Error) return payload.message
  return typeof payload === 'string' ? payload : 'Unknown Tauri window error'
}

export async function openWorkspaceTabWindow(tab: WorkspaceTab): Promise<boolean> {
  const route = toBrowserPath(workspaceTabRoute(tab))
  if (!isTauriRuntime()) {
    return Boolean(window.open(route, '_blank', 'noopener,noreferrer'))
  }

  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  const label = `workspace-${tab.id}-${Date.now()}`
  persistWorkspaceTabs(label, [tab], tab.id)
  stageWorkspaceTabTransfer(tab.id)
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
    transparent: false,
    decorations: platform !== 'win',
    titleBarStyle: platform === 'mac' ? 'overlay' : undefined,
    hiddenTitle: platform === 'mac',
    trafficLightPosition: platform === 'mac' ? new LogicalPosition(19, 21) : undefined,
    shadow: true,
    dragDropEnabled: false,
    tabbingIdentifier: platform === 'mac' ? 'io.wecode.wework.workspace' : undefined,
  })
  const cleanupFailedWindow = async () => {
    localStorage.removeItem(workspaceTabsStorageKey(label))
    clearStagedWorkspaceTabTransfer(tab.id)
    await workspaceWindow.destroy().catch(() => undefined)
  }

  let settled = false
  const unlisten: UnlistenFn[] = []
  await new Promise<void>((resolve, reject) => {
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      unlisten.forEach(dispose => disposeTauriListener(dispose, 'workspace window creation'))
      callback()
    }
    const fail = (error: unknown) => {
      finish(() => {
        void cleanupFailedWindow()
        reject(error instanceof Error ? error : new Error(errorMessage(error)))
      })
    }
    const rememberUnlisten = (listener: Promise<UnlistenFn>) => {
      void listener
        .then(dispose => {
          if (settled) {
            disposeTauriListener(dispose, 'workspace window creation')
            return
          }
          unlisten.push(dispose)
        })
        .catch(fail)
    }
    const timeout = window.setTimeout(() => {
      fail(new Error('Timed out creating workspace window'))
    }, WINDOW_CREATION_TIMEOUT_MS)

    rememberUnlisten(workspaceWindow.listen('tauri://created', () => finish(resolve)))
    rememberUnlisten(
      workspaceWindow.listen('tauri://error', event => fail(new Error(errorMessage(event.payload))))
    )
  })

  try {
    await workspaceWindow.show()
    await workspaceWindow.setFocus()
  } catch (error) {
    await cleanupFailedWindow()
    throw error
  }
  return true
}
