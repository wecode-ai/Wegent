import { createAsyncResource } from '@wegent/chat-core/async-resource'
import {
  getDefaultKeybindings,
  normalizeKeybinding,
  type KeybindingOverride,
} from '@/lib/keybindings'

interface KeybindingsApi {
  getKeybindings(): Promise<{ keybindings: KeybindingOverride[] }>
  updateKeybindings(input: {
    keybindings: KeybindingOverride[]
  }): Promise<{ keybindings: KeybindingOverride[] }>
}

/** Serial full-configuration writes retain every accepted edit, including after the page closes. */
export function createKeyboardShortcutsResource(
  api: () => KeybindingsApi | undefined,
  available: boolean,
  changed: () => void
) {
  let committed: KeybindingOverride[] | undefined
  let writeRevision = 0
  let reading: Promise<KeybindingOverride[]> | undefined
  const readSource = (signal?: AbortSignal) => {
    const revision = writeRevision
    const request: Promise<KeybindingOverride[]> = (async () => {
      const response = available ? await api()?.getKeybindings() : undefined
      const items = response?.keybindings ?? []
      if (!signal?.aborted && revision === writeRevision) committed = items
      return items
    })().finally(() => {
      if (reading === request) reading = undefined
    })
    reading = request
    return request
  }
  const query = createAsyncResource('local-keybindings', readSource, {
    failure: cause => console.error('[Wework] Failed to load keybindings:', cause),
  })
  const pending = new Set<string>()
  const listeners = new Set<() => void>()
  let failure: 'save' | undefined
  let tail = Promise.resolve()
  let stopQuery: (() => void) | undefined
  const read = () => {
    const state = query.getSnapshot()
    return {
      overrides: committed ?? state.data ?? [],
      loading: state.status === 'idle' || state.status === 'loading',
      saving: new Set(pending) as ReadonlySet<string>,
      error:
        failure ?? (pending.size === 0 && state.status === 'error' ? ('load' as const) : undefined),
    }
  }
  let snapshot = read()
  const publish = () => {
    snapshot = read()
    listeners.forEach(listener => listener())
  }
  const defaults = getDefaultKeybindings()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) stopQuery = query.subscribe(publish)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          stopQuery?.()
          stopQuery = undefined
        }
      }
    },
    save(command: string, key: string | null): Promise<boolean> {
      if (pending.has(command)) return Promise.resolve(false)
      pending.add(command)
      failure = undefined
      publish()
      const operation = tail.then(async () => {
        failure = undefined
        publish()
        const current = committed ?? (await (reading ?? readSource()))
        const next = current.filter(item => item.command !== command)
        const defaultKey = defaults.find(item => item.command === command)?.defaultKey ?? ''
        if (normalizeKeybinding(key ?? '') !== normalizeKeybinding(defaultKey))
          next.push({ command, key })
        const response = await api()?.updateKeybindings({ keybindings: next })
        writeRevision++
        committed = response?.keybindings ?? next
        query.update(() => committed)
        changed()
      })
      const result = operation
        .then(
          () => true,
          cause => {
            console.error('[Wework] Failed to save keybindings:', cause)
            failure = 'save'
            return false
          }
        )
        .finally(() => {
          pending.delete(command)
          publish()
        })
      tail = result.then(() => {})
      return result
    },
  }
}
