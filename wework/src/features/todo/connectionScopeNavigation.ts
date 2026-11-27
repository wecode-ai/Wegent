import { createContext, useContext, useImperativeHandle, type RefObject } from 'react'

export const ConnectionScopeNavigation = createContext<{
  back: RefObject<(() => void) | null>
  setTitle(title: string | null): void
} | null>(null)

export function useConnectionScopeTitle() {
  return useContext(ConnectionScopeNavigation)?.setTitle
}

export function useConnectionScopeBack(back: (() => void) | null) {
  const navigation = useContext(ConnectionScopeNavigation)
  useImperativeHandle<(() => void) | null, (() => void) | null>(navigation?.back, () => back, [
    back,
  ])
}
