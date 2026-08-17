/* eslint-disable react-refresh/only-export-components -- Pane presentation hooks share this context. */
import {
  createContext,
  memo,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import type { WorkbenchPaneIdentity } from './workbenchPaneIdentity'

export interface WorkbenchPanePresentation {
  visible: boolean
  focused: boolean
  headerActionsPortalId: string | null
  paneId: string
}

const WorkbenchPanePresentationContext = createContext<WorkbenchPanePresentation>({
  visible: true,
  focused: true,
  headerActionsPortalId: null,
  paneId: 'single',
})

function WorkbenchPanePresentationProvider({
  visible,
  focused,
  headerActionsPortalId,
  paneId,
  children,
}: WorkbenchPanePresentation & { children: ReactNode }) {
  const value = useMemo(
    () => ({ visible, focused, headerActionsPortalId, paneId }),
    [focused, headerActionsPortalId, paneId, visible]
  )
  return (
    <WorkbenchPanePresentationContext.Provider value={value}>
      {children}
    </WorkbenchPanePresentationContext.Provider>
  )
}

export function useWorkbenchPaneActive() {
  return useContext(WorkbenchPanePresentationContext).focused
}

export function useWorkbenchPaneVisible() {
  return useContext(WorkbenchPanePresentationContext).visible
}

export function useWorkbenchPaneHeaderActionsPortalId() {
  return useContext(WorkbenchPanePresentationContext).headerActionsPortalId
}

export function useWorkbenchPaneId() {
  return useContext(WorkbenchPanePresentationContext).paneId
}

export function WorkbenchPaneHost({ host }: { host: HTMLDivElement }) {
  const slotRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const slot = slotRef.current
    if (!slot || host.parentElement === slot) return
    slot.append(host)
    return () => {
      if (host.parentElement === slot) host.remove()
    }
  }, [host])

  return <div ref={slotRef} className="h-full min-h-0 min-w-0" />
}

export function WorkbenchPanePortal({
  pane,
  host,
  renderPane,
  visible,
  focused,
  headerActionsPortalId,
  paneId,
}: WorkbenchPanePresentation & {
  pane: WorkbenchPaneIdentity
  host: HTMLDivElement
  renderPane: (pane: WorkbenchPaneIdentity) => ReactNode
}) {
  return createPortal(
    <WorkbenchPanePresentationProvider
      visible={visible}
      focused={focused}
      headerActionsPortalId={headerActionsPortalId}
      paneId={paneId}
    >
      <CachedWorkbenchPane pane={pane} renderPane={renderPane} />
    </WorkbenchPanePresentationProvider>,
    host
  )
}

const CachedWorkbenchPane = memo(function CachedWorkbenchPane({
  pane,
  renderPane,
}: {
  pane: WorkbenchPaneIdentity
  renderPane: (pane: WorkbenchPaneIdentity) => ReactNode
}) {
  return <>{renderPane(pane)}</>
})
