import { useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export const TITLEBAR_ACTIONS_PORTAL_ID = 'titlebar-actions-portal'

interface TitlebarActionsPortalProps {
  children: ReactNode
}

export function TitlebarActionsPortal({
  children,
}: TitlebarActionsPortalProps) {
  const portalTarget = useSyncExternalStore(
    subscribeToPortalTarget,
    getPortalTarget,
    () => null,
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
