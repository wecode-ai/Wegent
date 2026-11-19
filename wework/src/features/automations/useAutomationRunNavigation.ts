import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import type { AutomationRun } from '@/types/automation'
import {
  createAutomationRunNavigation,
  type AutomationRunNavigationOptions,
} from './automationRunNavigation'

export function useAutomationRunNavigation(options: AutomationRunNavigationOptions) {
  const [source] = useState(createAutomationRunNavigation)
  const subscribe = useCallback(
    (notify: () => void) => source.subscribe(notify, options),
    [source, options]
  )
  const pending = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)
  return useMemo(
    () => Object.assign((run: AutomationRun) => source.open(run), { pending: pending > 0 }),
    [source, pending]
  )
}
