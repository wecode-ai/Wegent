import { trackBusinessEvent } from './businessEvents'
import type { StandInGeneratedEventMap } from './generated/standInEvents'

type Surface = StandInGeneratedEventMap['stand_in_opened']['surface']

/** One committed surface owner deduplicates visits without publishing local identifiers. */
export function createStandInOpenedReceipt() {
  let last: string | null = null
  return (surface: Surface, identity: 'primary' | 'role', active = true, instanceKey?: string) => {
    if (!active) {
      last = null
      return
    }
    const key = `${surface}:${identity}:${instanceKey ?? ''}`
    if (last === key) return
    last = key
    trackBusinessEvent('stand_in_opened', { domain: 'stand_in', surface, identity })
  }
}
