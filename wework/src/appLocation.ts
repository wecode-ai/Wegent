import { useState } from 'react'
import { useDOMEvent } from '@wegent/collaboration/dom-events'
import { stripAppBasePath } from '@/config/runtime'
export function useCurrentPath() {
  return useCurrentLocation().pathname
}
export function useCurrentLocation() {
  const [location, setLocation] = useState(() => ({
    pathname: stripAppBasePath(window.location.pathname),
    search: window.location.search,
  }))
  useDOMEvent<PopStateEvent>('window', 'popstate', () =>
    setLocation({
      pathname: stripAppBasePath(window.location.pathname),
      search: window.location.search,
    })
  )
  return location
}
