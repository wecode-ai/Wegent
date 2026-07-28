import { useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export const TITLEBAR_ACTIONS_PORTAL_ID = 'titlebar-actions-portal'
export const TITLEBAR_CENTER_PORTAL_ID = 'titlebar-center-portal'
export const TITLEBAR_RIGHT_PANEL_PORTAL_ID = 'titlebar-right-panel-portal'
export const WORKBENCH_MAIN_HEADER_PORTAL_ID = 'workbench-main-header-portal'

interface TitlebarActionsPortalProps {
  children: ReactNode
}

export function TitlebarActionsPortal({ children }: TitlebarActionsPortalProps) {
  const portalTarget = useSyncExternalStore(subscribeToPortalTarget, getPortalTarget, () => null)

  return portalTarget ? createPortal(children, portalTarget) : null
}

export function TitlebarCenterPortal({ children }: TitlebarActionsPortalProps) {
  const portalTarget = useSyncExternalStore(
    subscribeToPortalTarget,
    () => document.getElementById(TITLEBAR_CENTER_PORTAL_ID),
    () => null
  )

  return portalTarget ? createPortal(children, portalTarget) : null
}

export function TitlebarRightPanelPortal({ children }: TitlebarActionsPortalProps) {
  const portalTarget = useSyncExternalStore(
    subscribeToPortalTarget,
    () => document.getElementById(TITLEBAR_RIGHT_PANEL_PORTAL_ID),
    () => null
  )

  return portalTarget ? createPortal(children, portalTarget) : null
}

export function WorkbenchMainHeaderPortal({ children }: TitlebarActionsPortalProps) {
  const portalTarget = useSyncExternalStore(
    subscribeToPortalTarget,
    () => document.getElementById(WORKBENCH_MAIN_HEADER_PORTAL_ID),
    () => null
  )

  return portalTarget ? createPortal(children, portalTarget) : null
}

function getPortalTarget() {
  return document.getElementById(TITLEBAR_ACTIONS_PORTAL_ID)
}

function subscribeToPortalTarget(onStoreChange: () => void) {
  const observer = new MutationObserver(onStoreChange)
  observer.observe(document.body, { childList: true, subtree: true })
  return () => observer.disconnect()
}
