/* eslint-disable react-refresh/only-export-components -- Pane presentation hooks share this context. */
import { createE2ELifecycleTrace } from '@/e2e/lifecycleTrace'
import {
  createContext,
  memo,
  useContext,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import type { DeviceInfo } from '@/types/api'
import {
  getWorkbenchPaneKey,
  workbenchPanesShareTask,
  type WorkbenchPaneIdentity,
} from './workbenchPaneIdentity'

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

export function SingleWorkbenchPane({
  pane,
  devices = [],
  visible,
  renderPane,
}: {
  pane: WorkbenchPaneIdentity
  devices?: DeviceInfo[]
  visible: boolean
  renderPane: (pane: WorkbenchPaneIdentity) => ReactNode
}) {
  const paneKey = getWorkbenchPaneKey(pane)
  const [mounted, setMounted] = useState({ paneKey, mountKey: 0, pane })
  let mountKey = mounted.mountKey
  if (mounted.paneKey !== paneKey) {
    const sameTask = workbenchPanesShareTask(mounted.pane, pane, devices)
    // Discovery can replace an alias without changing the owning executor or task.
    mountKey = sameTask ? mounted.mountKey : mounted.mountKey + 1
    setMounted({ paneKey, mountKey, pane })
  }
  return (
    <div
      data-testid={visible ? 'desktop-workbench-main' : undefined}
      data-active-workbench-pane={visible ? 'true' : 'false'}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <WorkbenchPanePresentationProvider
        paneId={paneKey}
        visible={visible}
        focused={visible}
        headerActionsPortalId={null}
      >
        <CachedWorkbenchPane key={mountKey} pane={pane} renderPane={renderPane} />
      </WorkbenchPanePresentationProvider>
    </div>
  )
}

export function WorkbenchPaneHost({ host }: { host: HTMLDivElement }) {
  const bindSlot = useCallback(
    (slot: HTMLDivElement | null) => {
      if (!slot || host.parentElement === slot) return
      slot.append(host)
      const trace = createE2ELifecycleTrace('SplitWorkbenchPaneStack')
      trace.update({ paneKey: host.dataset.workbenchPaneHost, nativeHostAttached: true })
      return () => {
        trace.dispose()
        if (host.parentElement === slot) host.remove()
      }
    },
    [host]
  )

  return <div ref={bindSlot} className="h-full min-h-0 min-w-0" />
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
