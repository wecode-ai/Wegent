export interface AsyncResourceSnapshot<T> {
  status: 'idle' | 'loading' | 'ready' | 'error'
  settled: boolean
  data: T | undefined
  error: unknown
}
const IDLE = {
  status: 'idle' as const,
  settled: false,
  data: undefined,
  error: undefined,
}
export const getIdleResourceSnapshot = () => IDLE
export const subscribeIdleResource = () => () => {}

/** One request identity owns its snapshot; detached or superseded requests cannot publish.
 * A release callback makes successful values exclusive to active subscribers, without caching after detach.
 */
export function createAsyncResource<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
  options: {
    initialData?: T
    refreshOnSubscribe?: boolean
    delayMs?: number
    refreshIntervalMs?: number
    refreshIntervalMode?: 'fixed' | 'after-settle'
    release?(data: T): void
    success?(data: T): void
    failure?(error: unknown): void
  } = {}
) {
  let snapshot: AsyncResourceSnapshot<T> = {
    ...IDLE,
    data: options.initialData,
  }
  let revision = 0
  let observedVersion: unknown
  let controller: AbortController | undefined
  const listeners = new Set<() => void>()
  let refreshTimer: ReturnType<typeof setInterval> | undefined
  const publish = (state: AsyncResourceSnapshot<T>) => {
    const previous = snapshot.data
    snapshot = state
    listeners.forEach(listener => listener())
    if (previous !== undefined && previous !== state.data) options.release?.(previous)
  }
  const scheduleRefresh = (current: number) => {
    if (
      options.refreshIntervalMode !== 'after-settle' ||
      !options.refreshIntervalMs ||
      options.refreshIntervalMs <= 0 ||
      current !== revision ||
      !listeners.size
    )
      return
    clearInterval(refreshTimer)
    refreshTimer = setTimeout(() => void reload(), options.refreshIntervalMs)
  }
  const reload = (): Promise<void> => {
    const current = ++revision
    if (options.refreshIntervalMode === 'after-settle') {
      clearInterval(refreshTimer)
      refreshTimer = undefined
    }
    controller?.abort()
    controller = undefined
    publish({
      status: 'loading',
      settled: snapshot.settled,
      data: snapshot.data,
      error: snapshot.error,
    })
    if (current !== revision || !listeners.size) return Promise.resolve()
    controller = new AbortController()
    let request: Promise<T>
    try {
      request = delayedRequest(load, controller.signal, options.delayMs ?? 0)
    } catch (error) {
      request = Promise.reject(error)
    }
    return request
      .then(
        data => {
          if (current !== revision || !listeners.size) {
            options.release?.(data)
            return
          }
          controller = undefined
          publish({ status: 'ready', settled: true, data, error: undefined })
          if (current === revision && listeners.size) options.success?.(data)
        },
        error => {
          if (current !== revision || !listeners.size) return
          controller = undefined
          publish({
            status: 'error',
            settled: true,
            data: snapshot.data,
            error,
          })
          if (current === revision && listeners.size) options.failure?.(error)
        }
      )
      .finally(() => scheduleRefresh(current))
  }
  return {
    key,
    getSnapshot: () => snapshot,
    hasSubscribers: () => listeners.size > 0,
    reload,
    update(change: (data: T | undefined) => T | undefined) {
      if (!listeners.size) return
      const current = ++revision
      controller?.abort()
      controller = undefined
      publish({
        status: 'ready',
        settled: true,
        data: change(snapshot.data),
        error: undefined,
      })
      scheduleRefresh(current)
    },
    subscribe(listener: () => void, version?: unknown) {
      const invalidated = version !== undefined && observedVersion !== version
      if (version !== undefined) observedVersion = version
      listeners.add(listener)
      if (invalidated && listeners.size > 1) void reload()
      if (listeners.size === 1) {
        if (snapshot.status !== 'ready' || options.refreshOnSubscribe || invalidated) void reload()
        if (options.refreshIntervalMode === 'after-settle') {
          if (snapshot.status !== 'loading') scheduleRefresh(revision)
        } else if (options.refreshIntervalMs && options.refreshIntervalMs > 0)
          refreshTimer = setInterval(() => void reload(), options.refreshIntervalMs)
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          clearInterval(refreshTimer)
          refreshTimer = undefined
        }
        if (!listeners.size && (snapshot.status === 'loading' || options.release)) {
          revision++
          controller?.abort()
          controller = undefined
          const previous = snapshot.data
          snapshot = options.release ? { ...IDLE } : { ...snapshot, status: 'idle' }
          if (previous !== undefined && options.release) options.release(previous)
        }
      }
    },
  }
}

function delayedRequest<T>(
  load: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  delayMs: number
): Promise<T> {
  if (delayMs <= 0) return load(signal)
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel)
      try {
        resolve(load(signal))
      } catch (error) {
        reject(error)
      }
    }, delayMs)
    signal.addEventListener('abort', cancel, { once: true })
  })
}
