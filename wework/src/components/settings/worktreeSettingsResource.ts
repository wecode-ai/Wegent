import { createAsyncResource } from '@wegent/chat-core/async-resource'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeWorktreeSettings } from '@/types/api'

type SettingsReceipt = { settings: RuntimeWorktreeSettings; savedAt: number }

type RuntimeWorkApi = NonNullable<WorkbenchServices['runtimeWorkApi']>
export type WorktreeSettingsChange = Partial<
  Pick<RuntimeWorktreeSettings, 'worktreeRoot' | 'autoCleanupEnabled' | 'keepCount'>
>

export function createWorktreeSettingsResource(api: RuntimeWorkApi | undefined, deviceId: string) {
  if (!api || !deviceId) return undefined
  const settings = createAsyncResource('worktrees/settings', () =>
    api.getWorktreeSettings({ deviceId })
  )
  const items = createAsyncResource('worktrees/list', async () => {
    const response = await api.listWorktrees({ deviceId })
    if (!response.success) throw new Error('', { cause: response })
    return response.items
  })
  const active = () => settings.hasSubscribers() && items.hasSubscribers()
  // Accepted patches finish in order even after detach; only active subscribers receive receipts.
  let tail = Promise.resolve()
  const pending = new Set<Promise<SettingsReceipt>>()
  let lastAccepted: { key: string; operation: Promise<SettingsReceipt> } | undefined
  const updateSettings = (patch: WorktreeSettingsChange) => {
    const key = JSON.stringify(patch)
    if (lastAccepted?.key === key) return lastAccepted.operation
    const write = tail.then(() => api.updateWorktreeSettings({ deviceId, ...patch }))
    tail = write.then(
      () => undefined,
      () => undefined
    )
    const operation = write
      .then(receipt => {
        settings.update(() => receipt)
        return { settings: receipt, savedAt: Date.now() }
      })
      .finally(() => {
        pending.delete(operation)
        if (lastAccepted?.operation === operation) lastAccepted = undefined
      })
    pending.add(operation)
    lastAccepted = { key, operation }
    return operation
  }
  return {
    api,
    settings,
    items,
    actions: new Set<string>(),
    active,
    updateSettings,
    hasPendingSettings: () => pending.size > 0,
    reload: () => Promise.all([settings.reload(), items.reload()]),
  }
}
