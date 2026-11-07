import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'

export function useWorkspaceFileNavigation({
  dirty,
  savingRef,
  saveFileRef,
  pendingNavigationRef,
}: {
  dirty: boolean
  savingRef: RefObject<boolean>
  saveFileRef: RefObject<() => Promise<boolean>>
  pendingNavigationRef: RefObject<(() => void) | null>
}) {
  const dirtyRef = useRef(dirty)
  useLayoutEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  // Document state changes must not replay the active file-open request.
  return useCallback(
    (action: () => void) => {
      if (dirtyRef.current || savingRef.current) {
        pendingNavigationRef.current = action
        if (dirtyRef.current && !savingRef.current) void saveFileRef.current()
        return
      }
      action()
    },
    [pendingNavigationRef, saveFileRef, savingRef]
  )
}
