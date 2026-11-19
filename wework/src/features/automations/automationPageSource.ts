import type { SetStateAction } from 'react'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeWorkListResponse } from '@/types/api'
import type { Automation, AutomationRun } from '@/types/automation'
import { automationDraftFromAutomation, type AutomationDraft } from './automationDraft'

interface PageState {
  selectedAutomationId: string | null
  editing: Automation | null
  draft: AutomationDraft | null
  saving: boolean
  dirty: boolean
  pendingNavigation: (() => void) | null
  runningId: string | null
  error: string | null
  draftError: string | null
  dismissedReadErrors: unknown[]
}
interface Owner {
  api: WorkbenchServices['automationApi']
  userId?: number
  roleId?: string
  initialAutomationId?: string
}

/** The calendar's reads and draft share an owner while keeping independent request state. */
export function createAutomationPageSource(owner: Owner) {
  let state: PageState = {
    selectedAutomationId: null,
    editing: null,
    draft: null,
    saving: false,
    dirty: false,
    pendingNavigation: null,
    runningId: null,
    error: null,
    draftError: null,
    dismissedReadErrors: [],
  }
  const observers = new Set<{ notify(): void; dirty?(value: boolean): void }>()
  let generation = 0
  let navigationVersion = 0
  let initialResolved = false
  let runtimeWork: RuntimeWorkListResponse | null = null
  const patch = (change: Partial<PageState>) => {
    const previous = state
    state = { ...state, ...change }
    if (previous.selectedAutomationId !== state.selectedAutomationId) navigationVersion++
    for (const observer of observers) {
      if (previous.dirty !== state.dirty) observer.dirty?.(state.dirty)
      observer.notify()
    }
  }
  const set = <K extends keyof PageState>(key: K, value: SetStateAction<PageState[K]>) => {
    const next =
      typeof value === 'function'
        ? (value as (previous: PageState[K]) => PageState[K])(state[key])
        : value
    patch({ ...state, [key]: next })
  }
  const catalog = createAsyncResource<Automation[]>(
    'automation-calendar',
    async signal => {
      await Promise.resolve()
      signal.throwIfAborted()
      if (!observers.size) throw new DOMException('Automation page is inactive', 'AbortError')
      if (!owner.api)
        throw Object.assign(new Error('Automation API is unavailable'), {
          code: 'automation_api_unavailable',
        })
      const response = await owner.api.listAutomations()
      return response.items.filter(item => {
        const calendar = Boolean(item.taskRequest?.standInCalendar)
        if (owner.userId === undefined) return !calendar
        const identity = item.taskRequest?.standInOwner
        return (
          calendar &&
          Boolean(identity && identity.userId === owner.userId && identity.roleId === owner.roleId)
        )
      })
    },
    {
      failure() {
        if (observers.size) patch({ dismissedReadErrors: [] })
      },
      refreshIntervalMs: 30_000,
      refreshOnSubscribe: true,
      success(items) {
        if (initialResolved || !observers.size) return
        initialResolved = true
        const initial = owner.initialAutomationId
          ? items.find(item => item.id === owner.initialAutomationId)
          : owner.userId === undefined
            ? items[0]
            : undefined
        if (initial)
          patch({
            selectedAutomationId: initial.id,
            editing: initial,
            draft: automationDraftFromAutomation(initial, runtimeWork),
            dirty: false,
          })
      },
    }
  )
  const runReads = new Map<string, ReturnType<typeof createRunRead>>()
  function createRunRead(id: string) {
    const refreshers = new Set<() => Promise<void> | void>()
    let signature = ''
    let pendingRefresh = Promise.resolve()
    const resource = createAsyncResource<AutomationRun[]>(
      id,
      async signal => {
        await Promise.resolve()
        signal.throwIfAborted()
        if (!refreshers.size || !observers.size)
          throw new DOMException('Automation run view is inactive', 'AbortError')
        if (!owner.api) throw new Error('Automation API is unavailable')
        return (await owner.api.listAutomationRuns(id)).items
      },
      {
        failure() {
          if (observers.size) patch({ dismissedReadErrors: [] })
        },
        refreshIntervalMs: 2_000,
        refreshOnSubscribe: true,
        success(items) {
          const next = items.map(run => `${run.id}:${run.status}:${run.updatedAt}`).join('|')
          if (signature === next) return
          signature = next
          const refresh = [...refreshers].at(-1)
          if (refresh)
            pendingRefresh = Promise.resolve()
              .then(refresh)
              .catch(cause => {
                if (refreshers.size && observers.size)
                  patch({ error: cause instanceof Error ? cause.message : String(cause) })
              })
        },
      }
    )
    return {
      getSnapshot: resource.getSnapshot,
      async reload(forceRefresh?: () => Promise<void> | void) {
        const previous = pendingRefresh
        await resource.reload()
        if (!refreshers.size || !observers.size) return
        if (forceRefresh && previous === pendingRefresh) await forceRefresh()
        else await pendingRefresh
      },
      subscribe(notify: () => void, refreshWorkLists: () => Promise<void> | void) {
        let active = true
        const refresh = () => {
          if (active && observers.size) return refreshWorkLists()
        }
        refreshers.add(refresh)
        const stop = resource.subscribe(() => {
          if (active) notify()
        })
        return () => {
          active = false
          refreshers.delete(refresh)
          queueMicrotask(() => {
            stop()
            if (!refreshers.size) signature = ''
          })
        }
      },
    }
  }
  const runsFor = (id: string | null) => {
    if (!id) return undefined
    let read = runReads.get(id)
    if (!read) {
      read = createRunRead(id)
      runReads.set(id, read)
    }
    return read
  }
  return {
    catalog,
    runsFor,
    getSnapshot: () => state,
    subscribe(notify: () => void, onDirtyChange?: (dirty: boolean) => void) {
      const observer = { notify, dirty: onDirtyChange }
      observers.add(observer)
      onDirtyChange?.(state.dirty)
      return () => {
        observers.delete(observer)
        onDirtyChange?.(false)
        queueMicrotask(() => {
          if (!observers.size) generation++
        })
      }
    },
    subscribeCatalog(notify: () => void, work: RuntimeWorkListResponse | null) {
      runtimeWork = work
      let active = true
      const stop = catalog.subscribe(() => {
        if (active) notify()
      })
      return () => {
        active = false
        queueMicrotask(stop)
      }
    },
    capture(selection = false) {
      const current = generation
      const navigation = navigationVersion
      return () =>
        observers.size > 0 &&
        current === generation &&
        (!selection || navigation === navigationVersion)
    },
    resolveInitialSelection() {
      initialResolved = true
      navigationVersion++
    },
    requestLeave(action: () => void) {
      if (state.saving) return
      if (state.dirty) patch({ pendingNavigation: action })
      else action()
    },
    async loadAutomations() {
      if (observers.size) await catalog.reload()
    },
    async loadRuns(id: string, refreshWorkLists?: () => Promise<void> | void) {
      if (observers.size) await runsFor(id)?.reload(refreshWorkLists)
    },
    setSelectedAutomationId: (value: SetStateAction<string | null>) =>
      set('selectedAutomationId', value),
    setEditing: (value: SetStateAction<Automation | null>) => set('editing', value),
    setDraft: (value: SetStateAction<AutomationDraft | null>) => set('draft', value),
    setSaving: (value: SetStateAction<boolean>) => set('saving', value),
    setDirty: (value: SetStateAction<boolean>) => set('dirty', value),
    setPendingNavigation: (value: SetStateAction<(() => void) | null>) =>
      set('pendingNavigation', value),
    setRunningId: (value: SetStateAction<string | null>) => set('runningId', value),
    setDraftError: (value: SetStateAction<string | null>) => set('draftError', value),
    setError(value: string | null) {
      patch({
        error: value,
        ...(value === null
          ? {
              dismissedReadErrors: [
                catalog.getSnapshot().error,
                ...Array.from(runReads.values(), read => read.getSnapshot().error),
              ].filter(error => error !== undefined),
            }
          : {}),
      })
    },
  }
}
