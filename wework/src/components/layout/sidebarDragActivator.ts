import { PointerSensor, type PointerSensorOptions } from '@dnd-kit/core'
import type { PointerEvent as ReactPointerEvent } from 'react'

const SIDEBAR_DRAG_ACTIVATOR_SELECTOR = '[data-sidebar-drag-activator]'

export function isSidebarDragActivatorTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest(SIDEBAR_DRAG_ACTIVATOR_SELECTOR))
}

export class SidebarPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown' as const,
      handler: (
        { nativeEvent: event }: ReactPointerEvent,
        { onActivation }: PointerSensorOptions
      ) => {
        if (!event.isPrimary || event.button !== 0 || !isSidebarDragActivatorTarget(event.target)) {
          return false
        }
        onActivation?.({ event })
        return true
      },
    },
  ]
}
