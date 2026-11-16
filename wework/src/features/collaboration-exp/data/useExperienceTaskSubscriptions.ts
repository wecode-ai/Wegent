import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExperienceSource } from './useExperienceSources'

interface TaskSubscription {
  cancelled: boolean
  state: 'pending' | 'ready' | 'failed'
  release?: () => void
}

export function useExperienceTaskSubscriptions(
  sources: ExperienceSource[],
  active: boolean,
  refresh: () => void
) {
  const [errors, setErrors] = useState<ExperienceSource[]>([])
  const records = useRef(new Map<ExperienceSource, TaskSubscription>())
  const start = useCallback(
    (source: ExperienceSource) => {
      const subscribe = source.api.activity?.subscribeLoopItemChanges
      if (!subscribe) return
      const record: TaskSubscription = { cancelled: false, state: 'pending' }
      records.current.set(source, record)
      void Promise.resolve()
        .then(() =>
          subscribe(() => {
            if (!record.cancelled) refresh()
          })
        )
        .then(
          release => {
            if (record.cancelled) release()
            else {
              record.state = 'ready'
              record.release = release
              setErrors(previous => previous.filter(candidate => candidate !== source))
            }
          },
          () => {
            if (!record.cancelled) {
              record.state = 'failed'
              setErrors(previous => [...new Set([...previous, source])])
            }
          }
        )
    },
    [refresh]
  )
  useEffect(() => {
    if (!active) return
    const current = records.current
    sources.forEach(start)
    return () => {
      for (const record of current.values()) {
        record.cancelled = true
        record.release?.()
      }
      current.clear()
    }
  }, [sources, active, start])
  const retry = useCallback(() => {
    if (!active) return
    for (const source of sources) if (records.current.get(source)?.state === 'failed') start(source)
  }, [sources, active, start])
  return { retry, error: active && errors.some(source => sources.includes(source)) }
}
