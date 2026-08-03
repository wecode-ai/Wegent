import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  getActiveWorkspaceTabPortalOwner,
  syncWorkspaceTabPortalOwnerElement,
} from './workspaceTabPortalOwnership'

export const TITLEBAR_ACTIONS_PORTAL_ID = 'titlebar-actions-portal'
export const TITLEBAR_FEEDBACK_PORTAL_ID = 'titlebar-feedback-portal'
export const TITLEBAR_RIGHT_PANEL_PORTAL_ID = 'titlebar-right-panel-portal'
export const WORKBENCH_MAIN_HEADER_PORTAL_ID = 'workbench-main-header-portal'

interface TitlebarActionsPortalProps {
  children: ReactNode
}

const WorkspaceTabPortalOwnerContext = createContext<string | null>(null)

export function WorkspaceTabPortalOwner({
  children,
  ownerId,
}: {
  children: ReactNode
  ownerId: string
}) {
  return (
    <WorkspaceTabPortalOwnerContext.Provider value={ownerId}>
      {children}
    </WorkspaceTabPortalOwnerContext.Provider>
  )
}

export function TitlebarActionsPortal({ children }: TitlebarActionsPortalProps) {
  const portalTarget = useSyncExternalStore(subscribeToPortalTarget, getPortalTarget, () => null)

  return portalTarget ? createOwnedPortal(children, portalTarget) : null
}

export function TitlebarFeedbackPortal({ children }: TitlebarActionsPortalProps) {
  const portalTarget = useSyncExternalStore(
    subscribeToPortalTarget,
    () => document.getElementById(TITLEBAR_FEEDBACK_PORTAL_ID),
    () => null
  )

  return portalTarget ? createOwnedPortal(children, portalTarget) : null
}

export function TitlebarRightPanelPortal({ children }: TitlebarActionsPortalProps) {
  const portalTarget = useSyncExternalStore(
    subscribeToPortalTarget,
    () => document.getElementById(TITLEBAR_RIGHT_PANEL_PORTAL_ID),
    () => null
  )

  return portalTarget ? createOwnedPortal(children, portalTarget) : null
}

export function WorkbenchMainHeaderPortal({ children }: TitlebarActionsPortalProps) {
  const portalTarget = useSyncExternalStore(
    subscribeToPortalTarget,
    () => document.getElementById(WORKBENCH_MAIN_HEADER_PORTAL_ID),
    () => null
  )

  return portalTarget ? createOwnedPortal(children, portalTarget) : null
}

function getPortalTarget() {
  return document.getElementById(TITLEBAR_ACTIONS_PORTAL_ID)
}

function createOwnedPortal(children: ReactNode, portalTarget: HTMLElement) {
  return createPortal(<WorkspaceTabOwnedPortal>{children}</WorkspaceTabOwnedPortal>, portalTarget)
}

function WorkspaceTabOwnedPortal({ children }: { children: ReactNode }) {
  const ownerId = useContext(WorkspaceTabPortalOwnerContext)
  const syncVisibility = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element || !ownerId) return
      syncWorkspaceTabPortalOwnerElement(element, ownerId)
    },
    [ownerId]
  )

  if (!ownerId) return children

  const active = ownerId === getActiveWorkspaceTabPortalOwner()
  return (
    <div
      ref={syncVisibility}
      data-workspace-tab-portal-owner={ownerId}
      hidden={!active}
      style={{ display: active ? 'contents' : 'none' }}
    >
      {children}
    </div>
  )
}

function subscribeToPortalTarget(onStoreChange: () => void) {
  const observer = new MutationObserver(onStoreChange)
  observer.observe(document.body, { childList: true, subtree: true })
  return () => observer.disconnect()
}
