import { createAsyncResource } from '@wegent/chat-core/async-resource'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { IMPrivateSession } from '@/types/api'

export function createStandInImConnectionSource(
  api: WorkbenchServices['imSessionApi'],
  deviceId: string,
  roleId?: string
) {
  const resource = api
    ? createAsyncResource(
        'stand-in-im-sessions',
        async () => (await api.listPrivateSessions()).items
      )
    : null
  let ui = {
    channel: null as string | null,
    saving: null as string | null,
    saveFailed: false,
  }
  type Observer = { notify(): void; onOpenChange?(open: boolean): void }
  const observers = new Set<Observer>()
  let detach: (() => void) | undefined
  let cachedRead: unknown
  let cachedUi: unknown
  let snapshot: {
    channel: string | null
    saving: string | null
    sessions: IMPrivateSession[]
    loading: boolean
    error: 'load' | 'save' | null
  }
  const getSnapshot = () => {
    const read = resource?.getSnapshot()
    if (!snapshot || cachedRead !== read || cachedUi !== ui) {
      cachedRead = read
      cachedUi = ui
      snapshot = {
        channel: ui.channel,
        saving: ui.saving,
        sessions: read?.data ?? [],
        loading: Boolean(resource && (!read?.settled || read.status === 'loading')),
        error: ui.saveFailed ? 'save' : read?.status === 'error' ? 'load' : null,
      }
    }
    return snapshot
  }
  const notify = () => observers.forEach(observer => observer.notify())
  const patch = (values: Partial<typeof ui>) => {
    const before = ui.channel !== null
    ui = { ...ui, ...values }
    const after = ui.channel !== null
    if (before !== after) observers.forEach(observer => observer.onOpenChange?.(after))
    notify()
  }
  return {
    getSnapshot,
    setChannel(channel: string | null) {
      patch({ channel, saveFailed: false })
    },
    refresh() {
      patch({ saveFailed: false })
      void resource?.reload()
    },
    async connect(sessionKey: string) {
      if (!api || ui.saving || !observers.size) return
      patch({ saving: sessionKey, saveFailed: false })
      try {
        const binding = await api.bindStandIn(sessionKey, { deviceId, roleId: roleId ?? null })
        if (!observers.size) return
        resource?.update(items =>
          items?.map(session =>
            session.session_key === sessionKey
              ? { ...session, stand_in: binding, mode: 'stand_in' as const }
              : session
          )
        )
        patch({ saving: null })
      } catch {
        if (observers.size) patch({ saving: null, saveFailed: true })
      }
    },
    subscribe(notifyListener: () => void, onOpenChange?: (open: boolean) => void) {
      const observer = { notify: notifyListener, onOpenChange }
      observers.add(observer)
      onOpenChange?.(ui.channel !== null)
      if (!detach && resource) detach = resource.subscribe(notify)
      return () => {
        observers.delete(observer)
        queueMicrotask(() => {
          if (observers.size) return
          detach?.()
          detach = undefined
          onOpenChange?.(false)
        })
      }
    },
  }
}
