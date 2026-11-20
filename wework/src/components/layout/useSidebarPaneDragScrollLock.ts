import { useDOMEvent, useWindowEvent } from '@wegent/collaboration/dom-events'
import { useCallback, useRef, useState, type UIEvent } from 'react'
import {
  WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT,
  WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT,
} from './workbenchPaneDrag'

export function useSidebarPaneDragScrollLock() {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const dragActiveRef = useRef(false)
  const dragOutsideSidebarRef = useRef(false)
  const lockedScrollTopRef = useRef(0)
  const [dragOutsideSidebar, setDragOutsideSidebar] = useState(false)

  const setOutsideSidebar = (outside: boolean) => {
    if (dragOutsideSidebarRef.current === outside) return
    dragOutsideSidebarRef.current = outside
    setDragOutsideSidebar(outside)
  }
  useDOMEvent('window', WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT, () => {
    dragActiveRef.current = true
    lockedScrollTopRef.current = scrollContainerRef.current?.scrollTop ?? 0
  })
  useDOMEvent('window', WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT, () => {
    dragActiveRef.current = false
    setOutsideSidebar(false)
  })
  useWindowEvent(
    'pointermove',
    event => {
      if (!dragActiveRef.current) return
      const scrollContainer = scrollContainerRef.current
      if (!scrollContainer) return
      const bounds = scrollContainer.getBoundingClientRect()
      const outside = event.clientX < bounds.left || event.clientX > bounds.right
      if (outside && !dragOutsideSidebarRef.current)
        lockedScrollTopRef.current = scrollContainer.scrollTop
      setOutsideSidebar(outside)
      if (outside && scrollContainer.scrollTop !== lockedScrollTopRef.current)
        scrollContainer.scrollTop = lockedScrollTopRef.current
    },
    { capture: true }
  )

  const preserveLockedScrollPosition = useCallback((event: UIEvent<HTMLDivElement>) => {
    if (!dragOutsideSidebarRef.current) return false
    event.currentTarget.scrollTop = lockedScrollTopRef.current
    return true
  }, [])

  return {
    scrollContainerRef,
    dragOutsideSidebar,
    preserveLockedScrollPosition,
  }
}
