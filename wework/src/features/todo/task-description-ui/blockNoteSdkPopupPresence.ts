import { createContext, useCallback, useContext } from 'react'

export const BlockNoteSdkPopupContext = createContext<Set<symbol> | null>(null)

export function useBlockNoteSdkPopups() {
  const popups = useContext(BlockNoteSdkPopupContext)
  if (!popups) throw new Error('BlockNote SDK UI requires BlockNoteSdkProvider')
  return popups
}

export function useBlockNoteSdkPopupRef() {
  const popups = useBlockNoteSdkPopups()
  return useCallback(
    (element: HTMLElement | null) => {
      if (!element) return
      const token = Symbol('editor-popup')
      popups.add(token)
      return () => {
        popups.delete(token)
      }
    },
    [popups]
  )
}
