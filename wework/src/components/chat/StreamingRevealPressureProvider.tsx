import type { MutableRefObject, ReactNode } from 'react'
import { StreamingRevealPressureContext } from './StreamingRevealPressureContext'

export function StreamingRevealPressureProvider({
  revealScaleRef,
  children,
}: {
  revealScaleRef: MutableRefObject<number>
  children: ReactNode
}) {
  return (
    <StreamingRevealPressureContext.Provider value={revealScaleRef}>
      {children}
    </StreamingRevealPressureContext.Provider>
  )
}
