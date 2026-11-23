import type { ExperienceSource } from './useExperienceSources'

interface TaskSubscription {
  cancelled: boolean
  state: 'pending' | 'ready' | 'failed'
  release?: () => void
}

/** One visible task list owns its event subscriptions and their recoverable failures. */
export function createExperienceTaskSubscriptions(sources: ExperienceSource[]) {
  const records = new Map<ExperienceSource, TaskSubscription>()
  const observers = new Set<{ notify(): void; refresh(): void }>()
  let error = false
  const publish = () => {
    const next = [...records.values()].some(record => record.state === 'failed')
    if (next === error) return
    error = next
    observers.forEach(observer => observer.notify())
  }
  const start = (source: ExperienceSource) => {
    const subscribe = source.api.activity?.subscribeLoopItemChanges
    if (!subscribe) return
    const record: TaskSubscription = { cancelled: false, state: 'pending' }
    records.set(source, record)
    void Promise.resolve()
      .then(() => {
        if (record.cancelled) return
        return subscribe(() => {
          if (!record.cancelled) [...observers].at(-1)?.refresh()
        })
      })
      .then(
        release => {
          if (record.cancelled) release?.()
          else {
            record.state = 'ready'
            record.release = release
            publish()
          }
        },
        () => {
          if (!record.cancelled) {
            record.state = 'failed'
            publish()
          }
        }
      )
  }
  return {
    getSnapshot: () => error,
    subscribe(notify: () => void, refresh: () => void) {
      const observer = { notify, refresh }
      observers.add(observer)
      if (observers.size === 1 && !records.size) sources.forEach(start)
      return () => {
        observers.delete(observer)
        queueMicrotask(() => {
          if (observers.size) return
          for (const record of records.values()) {
            record.cancelled = true
            record.release?.()
          }
          records.clear()
          error = false
        })
      }
    },
    retry() {
      if (!observers.size) return
      for (const source of sources) if (records.get(source)?.state === 'failed') start(source)
    },
  }
}
