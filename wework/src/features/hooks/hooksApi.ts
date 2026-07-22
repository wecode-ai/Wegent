import { requestLocalExecutor } from '@/tauri/localExecutor'
import type { HookDraft, HookRunSummary, ResolvedHookPlugin } from './hooksTypes'

export const hooksApi = {
  async list() {
    return (await requestLocalExecutor<{ plugins: ResolvedHookPlugin[] }>('runtime.hooks.list'))
      .plugins
  },
  async reload() {
    return (await requestLocalExecutor<{ plugins: ResolvedHookPlugin[] }>('runtime.hooks.reload'))
      .plugins
  },
  async create(draft: HookDraft) {
    return (
      await requestLocalExecutor<{ plugin: ResolvedHookPlugin }>('runtime.hooks.create', {
        manifest: draft.manifest,
        hooks: draft.hooks,
      })
    ).plugin
  },
  async update(pluginId: string, draft: HookDraft) {
    return (
      await requestLocalExecutor<{ plugin: ResolvedHookPlugin }>('runtime.hooks.update', {
        pluginId,
        ...draft,
      })
    ).plugin
  },
  async install(path: string) {
    return (
      await requestLocalExecutor<{ plugin: ResolvedHookPlugin }>('runtime.hooks.install', { path })
    ).plugin
  },
  async setEnabled(pluginId: string, enabled: boolean) {
    return (
      await requestLocalExecutor<{ plugin: ResolvedHookPlugin }>('runtime.hooks.set_enabled', {
        pluginId,
        enabled,
      })
    ).plugin
  },
  async delete(pluginId: string) {
    await requestLocalExecutor('runtime.hooks.delete', { pluginId })
  },
  async reveal(pluginId: string) {
    return (await requestLocalExecutor<{ path: string }>('runtime.hooks.reveal', { pluginId })).path
  },
  async test(pluginId: string, handlerId: string, cwd?: string) {
    return (
      await requestLocalExecutor<{ run: HookRunSummary }>('runtime.hooks.test', {
        pluginId,
        handlerId,
        ...(cwd ? { cwd } : {}),
      })
    ).run
  },
}
