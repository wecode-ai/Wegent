import { useLayoutEffect, useMemo, useState, type SetStateAction } from 'react'
import type { CollaborationIssue } from '../types'
import type {
  SharedIssueDetailPort,
  SharedIssueDetailUpdateInput,
} from './createSharedIssueDetailPort'
import { persistIssueDetailFields } from './persistIssueDetailFields'

type IssuePatch = Omit<SharedIssueDetailUpdateInput, 'version'>
type Mutation = (source: CollaborationIssue) => Promise<CollaborationIssue>

export function createIssueDetailMutationQueue(initial: CollaborationIssue | null) {
  let source = initial
  let suppliedSource = initial
  let active = true
  let tail: Promise<unknown> = Promise.resolve()
  let publish: ((issue: CollaborationIssue) => void) | undefined
  const listeners = new Set<() => void>()

  function commit(updated: CollaborationIssue) {
    if (!active || !source || updated.id !== source.id || updated.version < source.version) return
    if (updated === source) return
    source = updated
    listeners.forEach(listener => listener())
    publish?.(updated)
  }

  return {
    sync(next: CollaborationIssue | null, onUpdated?: typeof publish) {
      // A callback-only render must not restore an old following snapshot.
      if (
        next &&
        next !== suppliedSource &&
        (!source || (next.id === source.id && next.version >= source.version))
      ) {
        const changed = source !== next
        source = next
        if (changed) listeners.forEach(listener => listener())
      }
      suppliedSource = next
      publish = onUpdated
    },
    setActive(value: boolean) {
      active = value
    },
    isActive: () => active,
    source: () => source,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    commit,
    run(write: Mutation): Promise<CollaborationIssue | null> {
      const request = tail.then(async () => {
        if (!active || !source) return null
        const updated = await write(source)
        if (!active) return null
        commit(updated)
        return source
      })
      tail = request.catch(() => undefined)
      return request
    },
  }
}

export function useIssueDetailMutations({
  source,
  scopeKey,
  port,
  onUpdated,
}: {
  source: CollaborationIssue | null
  scopeKey: string
  port: Pick<SharedIssueDetailPort, 'issues'>
  onUpdated?: (issue: CollaborationIssue) => void
}) {
  const queue = useMemo(
    () => ({ scopeKey, port, ...createIssueDetailMutationQueue(null) }),
    [scopeKey, port]
  )

  useLayoutEffect(() => {
    queue.setActive(true)
    return () => queue.setActive(false)
  }, [queue])

  useLayoutEffect(() => queue.sync(source, onUpdated), [queue, source, onUpdated])

  return useMemo(() => {
    const persist = (current: CollaborationIssue, patch: IssuePatch) =>
      persistIssueDetailFields(current, patch, port.issues, {
        onRefresh: queue.commit,
        isActive: queue.isActive,
      })
    return {
      ...queue,
      persist,
      update: (patch: IssuePatch) => queue.run(current => persist(current, patch)),
    }
  }, [queue, port])
}

const initialMutationState = {
  saving: false,
  identityBusy: false,
  securityBusy: false,
  saveError: null as string | null,
}

export function useIssueDetailMutationState(scope: object) {
  const [state, setState] = useState({ scope, ...initialMutationState })
  if (state.scope !== scope) setState({ scope, ...initialMutationState })

  const setters = useMemo(() => {
    function update<K extends keyof typeof initialMutationState>(
      key: K,
      value: SetStateAction<(typeof initialMutationState)[K]>
    ) {
      setState(current => {
        if (current.scope !== scope) return current
        return {
          ...current,
          [key]: typeof value === 'function' ? value(current[key]) : value,
        }
      })
    }
    return {
      setSaving: (value: SetStateAction<boolean>) => update('saving', value),
      setIdentityBusy: (value: SetStateAction<boolean>) => update('identityBusy', value),
      setSecurityBusy: (value: SetStateAction<boolean>) => update('securityBusy', value),
      setSaveError: (value: SetStateAction<string | null>) => update('saveError', value),
    }
  }, [scope])

  return { ...state, ...setters }
}
