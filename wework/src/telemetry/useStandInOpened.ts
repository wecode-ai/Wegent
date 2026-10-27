import { useEffect, useRef } from 'react'
import { trackBusinessEvent } from './businessEvents'
import type { StandInGeneratedEventMap } from './generated/standInEvents'

type Surface = StandInGeneratedEventMap['stand_in_opened']['surface']

export function useStandInOpened(
  surface: Surface,
  identity: 'primary' | 'role',
  active = true,
  instanceKey?: string
) {
  const last = useRef<string | null>(null)
  useEffect(() => {
    if (!active) {
      last.current = null
      return
    }
    const key = `${surface}:${identity}:${instanceKey ?? ''}`
    if (last.current === key) return
    last.current = key
    trackBusinessEvent('stand_in_opened', { domain: 'stand_in', surface, identity })
  }, [active, identity, instanceKey, surface])
}
