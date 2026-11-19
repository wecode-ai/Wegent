import { createContext, useContext, useEffect, useState } from 'react'

export const BlockNoteSdkPopupContext = createContext<Set<symbol> | null>(null)

export function useBlockNoteSdkPopups() {
  const popups = useContext(BlockNoteSdkPopupContext)
  if (!popups) throw new Error('BlockNote SDK UI requires BlockNoteSdkProvider')
  return popups
}

export function useBlockNoteSdkPopupPresence(open: boolean) {
  const popups = useBlockNoteSdkPopups()
  const [token] = useState(() => Symbol('editor-popup'))
  useEffect(() => {
    if (open) popups.add(token)
    return () => {
      popups.delete(token)
    }
  }, [open, popups, token])
}
