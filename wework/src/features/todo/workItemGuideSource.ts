import type { ProjectSpaceApi } from './projectSpaceSelection'
import {
  getWorkItemPickerOpen,
  setWorkItemPickerOpen,
  subscribeWorkItemPickerOpen,
} from './workItemPickerOpenState'

type TaskBinding = Awaited<ReturnType<ProjectSpaceApi['listTaskBindings']>>[number]
interface GuideInput {
  refreshKey: unknown
  projectId?: string | number
  projectStore?: string
  taskId?: string
  deviceId?: string
  canChangeProject?: boolean
}
let nextTraceId = 0

/** The visible guide owns its count read and the picker state that survives pane remounts. */
export function createWorkItemGuideSource(
  api: ProjectSpaceApi | undefined,
  itemId: string | undefined,
  pickerKey: string | null,
  ownerKey: string
) {
  let snapshot = {
    open: pickerKey !== null && getWorkItemPickerOpen(pickerKey),
    bindings: (itemId ? null : []) as TaskBinding[] | null,
    failed: false,
    loading: false,
  }
  let input: GuideInput | undefined
  let active = false
  let revision = 0
  let detachPicker: (() => void) | undefined
  const listeners = new Set<() => void>()
  const traceId = `work-item-guide:${ownerKey}:${++nextTraceId}`
  let previousTrace = ''
  const trace = (event: string) => {
    if (import.meta.env.VITE_WEWORK_E2E !== 'true') return
    const state = {
      open: snapshot.open,
      projectId: input?.projectId ?? null,
      projectStore: input?.projectStore ?? null,
      itemId: itemId ?? null,
      taskId: input?.taskId ?? null,
      deviceId: input?.deviceId ?? null,
      pickerStoreKey: pickerKey,
      canChangeProject: Boolean(input?.canChangeProject),
      menuOpen: snapshot.open && Boolean(input?.canChangeProject),
    }
    const signature = JSON.stringify(state)
    if (event === 'state' && signature === previousTrace) return
    if (event === 'state') previousTrace = signature
    if (event === 'mounted') previousTrace = ''
    console.debug('[Wework] Project picker lifecycle', JSON.stringify({ event, traceId, ...state }))
  }
  const publish = (patch: Partial<typeof snapshot>) => {
    snapshot = { ...snapshot, ...patch }
    trace('state')
    for (const listener of listeners) listener()
  }
  const reload = async () => {
    if (!active || !listeners.size || !api || !itemId) return
    const current = ++revision
    publish({ loading: true })
    try {
      const bindings = await api.listTaskBindings(itemId)
      if (active && current === revision) publish({ bindings, failed: false, loading: false })
    } catch {
      if (active && current === revision) publish({ failed: true, loading: false })
    }
  }
  return {
    getSnapshot: () => snapshot,
    reload,
    setOpen(update: boolean | ((open: boolean) => boolean)) {
      if (!active || !listeners.size) return
      const open = typeof update === 'function' ? update(snapshot.open) : update
      if (!open) trace('close-requested')
      if (pickerKey !== null) setWorkItemPickerOpen(pickerKey, open)
      else if (snapshot.open !== open) publish({ open })
    },
    subscribe(listener: () => void, next: GuideInput) {
      const refresh = !active || !input || input.refreshKey !== next.refreshKey
      input = next
      listeners.add(listener)
      if (!active) {
        active = true
        trace('mounted')
        if (pickerKey !== null) {
          const updatePicker = () => {
            const open = getWorkItemPickerOpen(pickerKey)
            if (snapshot.open !== open) publish({ open })
          }
          detachPicker = subscribeWorkItemPickerOpen(updatePicker)
          updatePicker()
        }
      }
      trace('state')
      if (refresh) void reload()
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          active = false
          revision++
          detachPicker?.()
          detachPicker = undefined
          trace('unmounted')
        })
      }
    },
  }
}
