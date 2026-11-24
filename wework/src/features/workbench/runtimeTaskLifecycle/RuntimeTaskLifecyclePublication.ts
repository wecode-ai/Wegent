import type {
  RuntimeTaskLifecycleSnapshot,
  RuntimeTaskLifecycleStoreSnapshot,
  RuntimeTaskSidebarStatus,
} from './types'

type Listener = () => void

const EMPTY_STORE_SNAPSHOT: RuntimeTaskLifecycleStoreSnapshot = {
  version: 0,
  tasks: new Map(),
  runningTaskKeys: new Set(),
  queuedTaskKeys: new Set(),
  unreadTaskKeys: new Set(),
}

export class RuntimeTaskLifecyclePublication {
  private readonly listeners = new Set<Listener>()
  private readonly taskListeners = new Map<string, Set<Listener>>()
  private snapshot = EMPTY_STORE_SNAPSHOT
  private sidebarStatus: RuntimeTaskSidebarStatus = {
    runningTaskKeys: EMPTY_STORE_SNAPSHOT.runningTaskKeys,
    waitingTaskKeys: new Set(),
    busyTaskKeys: new Set(),
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): RuntimeTaskLifecycleStoreSnapshot => this.snapshot

  getSidebarStatus = (): RuntimeTaskSidebarStatus => this.sidebarStatus

  subscribeTask = (taskId: string, listener: Listener): (() => void) => {
    const listeners = this.taskListeners.get(taskId) ?? new Set<Listener>()
    this.taskListeners.set(taskId, listeners)
    listeners.add(listener)
    return () => {
      if (listeners.delete(listener) && listeners.size === 0) this.taskListeners.delete(taskId)
    }
  }

  commit(updatedTasks: ReadonlyMap<string, RuntimeTaskLifecycleSnapshot | undefined>): void {
    const previous = this.snapshot
    const sidebar = this.sidebarStatus
    const runningTaskKeys = updateTaskKeys(previous.runningTaskKeys, updatedTasks, 'isRunning')
    const queuedTaskKeys = updateTaskKeys(previous.queuedTaskKeys, updatedTasks, 'isQueued')
    const unreadTaskKeys = updateTaskKeys(previous.unreadTaskKeys, updatedTasks, 'shouldShowUnread')
    const waitingTaskKeys = updateTaskKeys(
      sidebar.waitingTaskKeys,
      updatedTasks,
      'shouldShowSidebarWaiting'
    )
    const busyTaskKeys = updateTaskKeys(sidebar.busyTaskKeys, updatedTasks, 'isBusy')
    if (
      runningTaskKeys !== sidebar.runningTaskKeys ||
      waitingTaskKeys !== sidebar.waitingTaskKeys ||
      busyTaskKeys !== sidebar.busyTaskKeys
    ) {
      this.sidebarStatus = { runningTaskKeys, waitingTaskKeys, busyTaskKeys }
    }
    this.snapshot = {
      version: previous.version + 1,
      tasks: updateTaskSnapshots(previous.tasks, updatedTasks),
      runningTaskKeys,
      queuedTaskKeys,
      unreadTaskKeys,
    }
  }

  notify(updatedTaskIds: ReadonlySet<string>, aliasesChanged: boolean): void {
    // Aliases can rebind a subscriber even when neither device's machine changed.
    for (const taskId of aliasesChanged ? [...this.taskListeners.keys()] : updatedTaskIds) {
      this.taskListeners.get(taskId)?.forEach(listener => listener())
    }
    this.listeners.forEach(listener => listener())
  }
}

function updateTaskSnapshots(
  previous: ReadonlyMap<string, RuntimeTaskLifecycleSnapshot>,
  updates: ReadonlyMap<string, RuntimeTaskLifecycleSnapshot | undefined>
): ReadonlyMap<string, RuntimeTaskLifecycleSnapshot> {
  let next: Map<string, RuntimeTaskLifecycleSnapshot> | undefined
  for (const [key, task] of updates) {
    if (task === previous.get(key)) continue
    next ??= new Map(previous)
    if (task) next.set(key, task)
    else next.delete(key)
  }
  return next ?? previous
}

function updateTaskKeys(
  previous: ReadonlySet<string>,
  updates: ReadonlyMap<string, RuntimeTaskLifecycleSnapshot | undefined>,
  flag: keyof RuntimeTaskLifecycleSnapshot['derived']
): ReadonlySet<string> {
  let next: Set<string> | undefined
  for (const [key, task] of updates) {
    const included = task?.derived[flag] === true
    if (included === previous.has(key)) continue
    next ??= new Set(previous)
    if (included) next.add(key)
    else next.delete(key)
  }
  return next ?? previous
}
