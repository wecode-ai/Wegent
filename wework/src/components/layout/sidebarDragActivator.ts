const SIDEBAR_DRAG_ACTIVATOR_SELECTOR = '[data-sidebar-drag-activator]'

export function isSidebarDragActivatorTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest(SIDEBAR_DRAG_ACTIVATOR_SELECTOR))
}
