import { findRuntimeTask } from '@wegent/chat-core/runtime-task-lookup'
import type { RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'
import type { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'

interface PaneContextObservation {
  active: boolean
  current: RuntimeTaskAddress | null | undefined
  resolved: RuntimeTaskAddress | null | undefined
  runtimeWork: RuntimeWorkListResponse | null | undefined
  openTask(address: RuntimeTaskAddress): Promise<unknown>
}

function hasResolvedExecutionAddress(current: RuntimeTaskAddress, resolved: RuntimeTaskAddress) {
  return (
    current.deviceId === resolved.deviceId &&
    current.taskId === resolved.taskId &&
    current.runtime === resolved.runtime &&
    current.threadId === resolved.threadId &&
    current.workspacePath === resolved.workspacePath &&
    current.workspaceKind === resolved.workspaceKind &&
    current.worktreeId === resolved.worktreeId &&
    JSON.stringify(current.runtimeHandle?.modelSelection ?? null) ===
      JSON.stringify(resolved.runtimeHandle?.modelSelection ?? null)
  )
}

export function readDesktopPaneRuntimeTaskSummary(
  store: RuntimeTaskLifecycleStore,
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  address: RuntimeTaskAddress | null | undefined
) {
  return (
    findRuntimeTask(runtimeWork, address) ??
    store.selectTask(store.getSnapshot(), address)?.task ??
    null
  )
}

function readPaneContext(store: RuntimeTaskLifecycleStore, input: PaneContextObservation) {
  const currentRuntimeTask = input.current ?? null
  const runtimeTaskSummary = readDesktopPaneRuntimeTaskSummary(
    store,
    input.runtimeWork,
    currentRuntimeTask
  )
  const currentRuntimeConversationSource: RuntimeTaskAddress | null =
    currentRuntimeTask && runtimeTaskSummary
      ? {
          ...currentRuntimeTask,
          runtime: runtimeTaskSummary.runtime,
          workspacePath: runtimeTaskSummary.workspacePath || currentRuntimeTask.workspacePath,
          threadId: runtimeTaskSummary.threadId ?? currentRuntimeTask.threadId,
          runtimeHandle: runtimeTaskSummary.runtimeHandle ?? currentRuntimeTask.runtimeHandle,
        }
      : currentRuntimeTask
  return { currentRuntimeTask, runtimeTaskSummary, currentRuntimeConversationSource }
}

/** One pane/account owns its live execution context and bound-address navigation. */
export function createDesktopPaneContextSource(store: RuntimeTaskLifecycleStore) {
  const listeners = new Set<() => void>()
  let release: (() => void) | undefined
  let committed: PaneContextObservation | undefined
  let generation = 0
  let attempted: { current: RuntimeTaskAddress; resolved: RuntimeTaskAddress } | undefined
  const notify = () => listeners.forEach(listener => listener())
  const reconcile = (next: PaneContextObservation, wasActive: boolean) => {
    const { active, current, resolved } = next
    if (!active || !current || !resolved || hasResolvedExecutionAddress(current, resolved)) {
      attempted = undefined
      return
    }
    if (
      wasActive &&
      attempted &&
      hasResolvedExecutionAddress(attempted.current, current) &&
      hasResolvedExecutionAddress(attempted.resolved, resolved)
    )
      return
    attempted = { current, resolved }
    const ownerGeneration = generation
    // openTask commits its selected address synchronously. Its runtime service retains
    // the existing generation, held-session and active-route fences for later reads.
    void next.openTask(resolved).catch(error => {
      if (!listeners.size || ownerGeneration !== generation || committed !== next) return
      console.error('[Workbench] Failed to reconcile the pane execution address', error)
    })
  }
  return {
    observe(input: PaneContextObservation) {
      let lifecycleSnapshot = store.getSnapshot()
      let snapshot = readPaneContext(store, input)
      const getSnapshot = () => {
        const next = store.getSnapshot()
        if (lifecycleSnapshot !== next) {
          lifecycleSnapshot = next
          snapshot = readPaneContext(store, input)
        }
        return snapshot
      }
      return {
        getSnapshot,
        subscribe(listener: () => void) {
          const wasActive = committed?.active ?? false
          committed = input
          listeners.add(listener)
          if (!release) release = store.subscribe(notify)
          reconcile(input, wasActive)
          return () => {
            listeners.delete(listener)
            queueMicrotask(() => {
              if (listeners.size) return
              generation += 1
              attempted = undefined
              committed = undefined
              release?.()
              release = undefined
            })
          }
        },
      }
    },
  }
}
