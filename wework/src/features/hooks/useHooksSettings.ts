import { useCallback, useEffect, useRef, useState } from 'react'
import { hooksApi } from './hooksApi'
import { subscribeLocalExecutorEvents } from '@/tauri/localExecutor'
import type { HookDraft, ResolvedHookPlugin } from './hooksTypes'
import { track } from '@/telemetry/client'

export function useHooksSettings() {
  const [data, setData] = useState<ResolvedHookPlugin[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mutations = useRef(new Map<string, Promise<unknown>>())
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await hooksApi.list())
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void Promise.resolve().then(load)
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void subscribeLocalExecutorEvents(message => {
      if (
        message.event === 'runtime.hooks.changed' ||
        message.event === 'runtime.hooks.run_completed'
      ) {
        void load()
      }
    }).then(value => {
      if (disposed) value()
      else unsubscribe = value
    })
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [load])
  const serialize = useCallback(async <T>(id: string, operation: () => Promise<T>) => {
    const previous = mutations.current.get(id) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    mutations.current.set(id, current)
    try {
      return await current
    } finally {
      if (mutations.current.get(id) === current) mutations.current.delete(id)
    }
  }, [])
  const replace = useCallback(
    (plugin: ResolvedHookPlugin) =>
      setData(items =>
        [...items.filter(item => item.manifest.id !== plugin.manifest.id), plugin].sort((a, b) =>
          a.manifest.name.localeCompare(b.manifest.name)
        )
      ),
    []
  )
  const runMutation = useCallback(
    async <T>(
      action: 'create' | 'update' | 'enable' | 'disable' | 'delete' | 'install' | 'test',
      operation: () => Promise<T>
    ) => {
      try {
        const result = await operation()
        track('feature_action_completed', { domain: 'hook', action })
        return result
      } catch (error) {
        track('operation_failed', { operation: 'hook_action' })
        throw error
      }
    },
    []
  )
  return {
    data,
    loading,
    error,
    reload: load,
    create: async (draft: HookDraft) =>
      replace(
        await runMutation('create', () =>
          serialize(draft.manifest.id, () => hooksApi.create(draft))
        )
      ),
    update: async (id: string, draft: HookDraft) =>
      replace(await runMutation('update', () => serialize(id, () => hooksApi.update(id, draft)))),
    setEnabled: async (id: string, enabled: boolean) =>
      replace(
        await runMutation(enabled ? 'enable' : 'disable', () =>
          serialize(id, () => hooksApi.setEnabled(id, enabled))
        )
      ),
    remove: async (id: string) => {
      await runMutation('delete', () => serialize(id, () => hooksApi.delete(id)))
      setData(items => items.filter(item => item.manifest.id !== id))
    },
    test: (id: string, handlerId: string, cwd?: string) =>
      runMutation('test', () => hooksApi.test(id, handlerId, cwd)),
    reveal: hooksApi.reveal,
    install: async (path: string) =>
      replace(await runMutation('install', () => hooksApi.install(path))),
  }
}
