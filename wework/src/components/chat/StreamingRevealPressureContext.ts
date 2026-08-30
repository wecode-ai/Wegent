import { createContext, useContext, useRef, type MutableRefObject } from 'react'

export const StreamingRevealPressureContext = createContext<MutableRefObject<number> | null>(null)

export function useStreamingRevealScale(): MutableRefObject<number> {
  const fallbackRef = useRef(1)
  return useContext(StreamingRevealPressureContext) ?? fallbackRef
}
