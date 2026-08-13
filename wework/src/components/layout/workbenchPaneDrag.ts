export const WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT = 'wework:workbench-sidebar-pane-drag-start'
export const WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT = 'wework:workbench-sidebar-pane-drag-end'

export interface WorkbenchSidebarPaneDragData {
  paneKey: string
  title: string
}

export interface WorkbenchSidebarPaneDragEndData extends WorkbenchSidebarPaneDragData {
  clientX: number
  clientY: number
  handled: boolean
}

export function dispatchWorkbenchSidebarPaneDragStart(data: WorkbenchSidebarPaneDragData) {
  window.dispatchEvent(
    new CustomEvent<WorkbenchSidebarPaneDragData>(WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT, {
      detail: data,
    })
  )
}

export function dispatchWorkbenchSidebarPaneDragEnd(data: WorkbenchSidebarPaneDragEndData) {
  window.dispatchEvent(
    new CustomEvent<WorkbenchSidebarPaneDragEndData>(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT, {
      detail: data,
    })
  )
}

export function dispatchWorkbenchSidebarPaneDragCancel() {
  window.dispatchEvent(
    new CustomEvent<null>(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT, { detail: null })
  )
}
