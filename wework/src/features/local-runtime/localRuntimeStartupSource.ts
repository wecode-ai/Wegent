import {
  createLocalExecutorCloudService,
  type LocalExecutorCloudInput,
} from '@/features/cloud-connection/localExecutorCloudService'
export type LocalRuntimeState =
  | { phase: 'starting'; error: string | null }
  | { phase: 'ready'; error: null }
  | { phase: 'failed'; error: string; cause: unknown }

type StartupResolver = () => Promise<LocalRuntimeState>

/** Owns executor readiness, retry progress and the visible slow-start warning. */
export function createLocalRuntimeStartupSource(enabled: boolean, slowStartupMs: number) {
  let snapshot = {
    state: { phase: enabled ? 'starting' : 'ready', error: null } as LocalRuntimeState,
    startupAttempt: 0,
    slowStartupTimedOut: false,
  }
  const listeners = new Set<() => void>()
  const cloudService = createLocalExecutorCloudService()
  let cloud: LocalExecutorCloudInput | undefined
  const synchronizeCloud = () => {
    if (
      listeners.size &&
      cloud &&
      (snapshot.state.phase !== 'starting' || snapshot.startupAttempt > 0)
    )
      cloudService.observe(cloud)
    else cloudService.dispose()
  }
  let resolve: StartupResolver | undefined
  let prepareExecutor: (() => Promise<LocalRuntimeState | null>) | undefined
  let observing = false
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let slowDeadline: number | undefined
  const publish = (patch: Partial<typeof snapshot>) => {
    snapshot = { ...snapshot, ...patch }
    synchronizeCloud()
    for (const listener of listeners) listener()
  }
  const scheduleSlowWarning = () => {
    clearTimeout(timer)
    slowDeadline ??= Date.now() + slowStartupMs
    if (snapshot.slowStartupTimedOut) return
    timer = setTimeout(
      () => {
        if (listeners.size) publish({ slowStartupTimedOut: true })
      },
      Math.max(0, slowDeadline - Date.now())
    )
  }
  async function initialize() {
    if (!enabled || !resolve || !listeners.size) return
    const current = ++generation
    const next = await resolve()
    if (current !== generation || !listeners.size) return
    publish({ state: next })
    if (next.phase === 'ready' && prepareExecutor) {
      const prepare = prepareExecutor
      // Publish the usable workbench before preparing recovery and default plugins.
      queueMicrotask(() => {
        if (current !== generation || !listeners.size) return
        void prepare().then(failure => {
          if (failure && current === generation && listeners.size) publish({ state: failure })
        })
      })
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(
      listener: () => void,
      resolver: StartupResolver,
      cloudInput?: LocalExecutorCloudInput,
      prepare?: () => Promise<LocalRuntimeState | null>
    ) {
      resolve = resolver
      prepareExecutor = prepare
      cloud = cloudInput
      listeners.add(listener)
      synchronizeCloud()
      if (enabled && !observing) {
        observing = true
        scheduleSlowWarning()
        void initialize()
      }
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          observing = false
          cloudService.dispose()
          generation += 1
          clearTimeout(timer)
        })
      }
    },
    retry() {
      if (!enabled || !listeners.size) return Promise.resolve()
      slowDeadline = undefined
      publish({
        state: { phase: 'starting', error: snapshot.state.error },
        startupAttempt: snapshot.startupAttempt + 1,
        slowStartupTimedOut: false,
      })
      scheduleSlowWarning()
      return initialize()
    },
  }
}
