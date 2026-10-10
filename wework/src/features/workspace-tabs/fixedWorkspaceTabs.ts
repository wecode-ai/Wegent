import {
  updateAppPreferences,
  type AppPreferences,
  type FixedWorkspaceTabPreference,
} from '@/desktop/appPreferences'
import type { WorkspaceTab } from './workspaceTabs'

function harnessAppInstallationId(contentRoute: string): string | null {
  const pathname = contentRoute.split('?', 1)[0]
  const prefix = '/app/harness-'
  if (!pathname.startsWith(prefix)) return null
  try {
    return decodeURIComponent(pathname.slice(prefix.length)) || null
  } catch {
    return null
  }
}

export function fixedWorkspaceTabPreference(tab: WorkspaceTab): FixedWorkspaceTabPreference {
  const installationId = harnessAppInstallationId(tab.contentRoute)
  if (installationId) {
    return {
      id: tab.id,
      kind: 'smart_app',
      installationId,
      title: tab.title,
    }
  }
  return {
    id: tab.id,
    kind: tab.kind,
    title: tab.title,
    contentRoute: tab.contentRoute,
  }
}

export function fixedWorkspaceTabsPatch(
  fixedWorkspaceTabs: FixedWorkspaceTabPreference[],
  startupWorkspaceTabId: string
): Pick<AppPreferences, 'fixedWorkspaceTabs' | 'startupWorkspaceTabId'> {
  return {
    fixedWorkspaceTabs,
    startupWorkspaceTabId: fixedWorkspaceTabs.some(tab => tab.id === startupWorkspaceTabId)
      ? startupWorkspaceTabId
      : (fixedWorkspaceTabs[0]?.id ?? ''),
  }
}

export function saveFixedWorkspaceTabs(
  fixedWorkspaceTabs: FixedWorkspaceTabPreference[],
  startupWorkspaceTabId: string
): Promise<AppPreferences> {
  return updateAppPreferences(fixedWorkspaceTabsPatch(fixedWorkspaceTabs, startupWorkspaceTabId))
}

export function fixedWorkspaceWindowLabel(tabId: string): string {
  const safeTabId = tabId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48) || 'tab'
  return `workspace-${safeTabId}-${crypto.randomUUID()}`
}
