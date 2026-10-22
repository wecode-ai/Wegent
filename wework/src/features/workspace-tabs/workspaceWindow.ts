import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { toBrowserPath } from '@/lib/navigation'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import {
  persistWorkspaceTabs,
  workspaceTabRoute,
  workspaceTabsStorageKey,
  type WorkspaceTab,
} from './workspaceTabs'
import { clearStagedWorkspaceTabTransfer, stageWorkspaceTabTransfer } from './workspaceTabTransfer'

export const WORKSPACE_TAB_RETURN_PREFIX = 'wework.workspaceTabReturn.v1:'

export async function returnWorkspaceTabToMain(tab: WorkspaceTab): Promise<void> {
  endActiveEditingSession()
  stageWorkspaceTabTransfer(tab.id)
  const key = `${WORKSPACE_TAB_RETURN_PREFIX}${crypto.randomUUID()}`
  try {
    await invokeDesktopHost('window.showMain')
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout)
        window.removeEventListener('storage', acknowledge)
      }
      const acknowledge = (event: StorageEvent) => {
        if (event.key !== key) return
        if (event.newValue !== null) {
          const result = JSON.parse(event.newValue) as { error?: string }
          if (!result.error) return
          cleanup()
          reject(new Error(result.error))
          return
        }
        cleanup()
        resolve()
      }
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error('Main window did not accept the workspace tab'))
      }, 10_000)
      window.addEventListener('storage', acknowledge)
      try {
        localStorage.setItem(key, JSON.stringify(tab))
      } catch (error) {
        cleanup()
        reject(error)
      }
    })
  } catch (error) {
    clearStagedWorkspaceTabTransfer(tab.id)
    throw error
  } finally {
    localStorage.removeItem(key)
  }
}

export async function closeEmptyWorkspaceWindow(): Promise<void> {
  const label = getDesktopWindowLabel()
  localStorage.removeItem(workspaceTabsStorageKey(label))
  await invokeDesktopHost('window.closeWorkspace', { label })
}

function endActiveEditingSession(): void {
  const activeElement = document.activeElement
  if (activeElement instanceof HTMLElement) activeElement.blur()
}

export async function openWorkspaceTabWindow(
  tab: WorkspaceTab,
  options: { label?: string; transferState?: boolean } = {}
): Promise<boolean> {
  const route = toBrowserPath(workspaceTabRoute(tab))
  const label = options.label ?? `workspace-${tab.id}-${Date.now()}`
  endActiveEditingSession()
  persistWorkspaceTabs(label, [tab], tab.id)
  if (options.transferState !== false) stageWorkspaceTabTransfer(tab.id)
  try {
    await invokeDesktopHost('window.openWorkspace', { label, route, title: tab.title })
    return true
  } catch (error) {
    localStorage.removeItem(workspaceTabsStorageKey(label))
    if (options.transferState !== false) clearStagedWorkspaceTabTransfer(tab.id)
    throw error
  }
}
