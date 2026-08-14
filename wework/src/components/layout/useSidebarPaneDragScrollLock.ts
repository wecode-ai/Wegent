import { useCallback, useEffect, useRef, useState, type UIEvent } from 'react'
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

  useEffect(() => {
    const setOutsideSidebar = (outside: boolean) => {
      if (dragOutsideSidebarRef.current === outside) return
      dragOutsideSidebarRef.current = outside
      setDragOutsideSidebar(outside)
    }
    const handleDragStart = () => {
      dragActiveRef.current = true
      lockedScrollTopRef.current = scrollContainerRef.current?.scrollTop ?? 0
    }
    const handlePointerMove = (event: PointerEvent) => {
      if (!dragActiveRef.current) return
      const scrollContainer = scrollContainerRef.current
      if (!scrollContainer) return
      const bounds = scrollContainer.getBoundingClientRect()
      const outside = event.clientX < bounds.left || event.clientX > bounds.right
      if (outside && !dragOutsideSidebarRef.current) {
        lockedScrollTopRef.current = scrollContainer.scrollTop
      }
      setOutsideSidebar(outside)
      if (outside && scrollContainer.scrollTop !== lockedScrollTopRef.current) {
        scrollContainer.scrollTop = lockedScrollTopRef.current
      }
    }
    const handleDragEnd = () => {
      dragActiveRef.current = false
      setOutsideSidebar(false)
    }

    window.addEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT, handleDragStart)
    window.addEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT, handleDragEnd)
    window.addEventListener('pointermove', handlePointerMove, true)
    return () => {
      window.removeEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT, handleDragStart)
      window.removeEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT, handleDragEnd)
      window.removeEventListener('pointermove', handlePointerMove, true)
    }
  }, [])

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
