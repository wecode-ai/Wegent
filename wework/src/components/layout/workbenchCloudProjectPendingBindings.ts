import {
  publishProjectSpaceTaskBindingChanged,
  type ProjectSpaceTaskBindingChange,
} from '@/features/todo/projectSpaceSelection'
import type { ProjectTaskRuntimeApi } from '@/features/workbench/projectTaskTracking'
import type { CloudLoopItem } from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeTaskAddress } from '@/types/api'
import type {
  PendingTodoBinding,
  BoundProjectSpaceContextUpdate,
} from './workbenchCloudProjectContextModel'
import { runtimeTaskKey, runtimeContextAddress } from './workbenchCloudProjectContextModel'
import { projectSpaceKey, projectSpaceRef } from '@/features/todo/projectSpaceSelection'

const identities = new WeakMap<object, number>()
let sequence = 0
const identity = (value: object | undefined) => {
  if (!value) return null
  let key = identities.get(value)
  if (key === undefined) {
    key = ++sequence
    identities.set(value, key)
  }
  return key
}
function createPendingBindings() {
  const panes = new Map<string, PendingTodoBinding>()
  const tasks = new Map<string, PendingTodoBinding>()
  const listeners = new Set<(update: BoundProjectSpaceContextUpdate) => void>()
  const confirmed = new WeakSet<BoundProjectSpaceContextUpdate>()
  let publication: ProjectSpaceTaskBindingChange | null = null
  const publishBound = (update: BoundProjectSpaceContextUpdate) =>
    listeners.forEach(listener => listener(update))
  const operations = new WeakMap<ProjectTaskRuntimeApi, Map<string, Promise<CloudLoopItem>>>()
  const clear = (binding: PendingTodoBinding) => {
    if (panes.get(binding.paneKey) === binding) panes.delete(binding.paneKey)
    if (binding.target && tasks.get(runtimeTaskKey(binding.target)) === binding)
      tasks.delete(runtimeTaskKey(binding.target))
  }
  return {
    publishBound,
    getPublication: () => publication,
    confirmBound(update: BoundProjectSpaceContextUpdate) {
      if (confirmed.has(update)) return
      confirmed.add(update)
      const change: ProjectSpaceTaskBindingChange = {
        task: runtimeContextAddress(update.task),
        project: projectSpaceRef(update.project),
        type: 'bound',
      }
      publication = change
      try {
        publishProjectSpaceTaskBindingChanged(change)
      } finally {
        publication = null
      }
    },
    get(task: RuntimeTaskAddress | null, paneKey: string) {
      return task ? (tasks.get(runtimeTaskKey(task)) ?? null) : (panes.get(paneKey) ?? null)
    },
    store(binding: PendingTodoBinding, previous?: PendingTodoBinding) {
      if (binding.target) {
        tasks.set(runtimeTaskKey(binding.target), binding)
        if (panes.get(binding.paneKey) === (previous ?? binding)) panes.delete(binding.paneKey)
      } else panes.set(binding.paneKey, binding)
      return binding
    },
    clear,
    has(task: RuntimeTaskAddress) {
      return tasks.has(runtimeTaskKey(task))
    },
    subscribe(listener: (update: BoundProjectSpaceContextUpdate) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async bind(
      binding: PendingTodoBinding,
      task: RuntimeTaskAddress,
      api: ProjectTaskRuntimeApi,
      title: string
    ) {
      let pending = operations.get(api)
      if (!pending) {
        pending = new Map()
        operations.set(api, pending)
      }
      const key = JSON.stringify([
        runtimeTaskKey(task),
        projectSpaceKey(projectSpaceRef(binding.project)),
        binding.item?.id,
      ])
      const existing = pending.get(key)
      if (existing) return existing
      const request = (async () => {
        const item = binding.item
          ? (await api.bindTask(binding.item.id, task, title), binding.item)
          : (await api.trackProjectTask(binding.project.id, task, title, binding.description)).item
        clear(binding)
        const update = { task, project: binding.project, item }
        publishBound(update)
        return item
      })()
      pending.set(key, request)
      try {
        return await request
      } finally {
        if (pending.get(key) === request) pending.delete(key)
      }
    },
  }
}
const registries = new Map<string, ReturnType<typeof createPendingBindings>>()
export function workbenchCloudProjectPendingBindings(
  userId: number | undefined,
  services: WorkbenchServices | undefined
) {
  const key = JSON.stringify([
    userId,
    identity(services?.deliveryApi),
    identity(services?.projectSpaceApis?.local),
    identity(services?.projectSpaceApis?.cloud),
    identity(services?.workspaceRuntimePort),
  ])
  let registry = registries.get(key)
  if (!registry) {
    registry = createPendingBindings()
    registries.set(key, registry)
  }
  return registry
}
export type WorkbenchCloudPendingBindings = ReturnType<typeof createPendingBindings>
