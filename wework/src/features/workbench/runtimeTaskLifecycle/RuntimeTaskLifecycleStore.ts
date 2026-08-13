import type {
  RuntimeDeviceWorkspace,
  RuntimeGoalStatus,
  RuntimeTaskAddress,
  RuntimeTaskSummary,
  RuntimeWorkListResponse,
} from '@/types/api'
import type { RuntimePaneTranscript } from '@/types/workbench'
import { RuntimeTaskMachine, getRuntimeTaskLifecycleKey } from './RuntimeTaskMachine'
import type {
  RuntimeTaskLifecycleEvent,
  RuntimeTaskLifecycleSnapshot,
  RuntimeTaskLifecycleStoreSnapshot,
} from './types'

type Listener = () => void

interface SyncTranscriptOptions {
  preserveActiveTurn?: boolean
}

const EMPTY_STORE_SNAPSHOT: RuntimeTaskLifecycleStoreSnapshot = {
  version: 0,
  tasks: new Map(),
  runningTaskKeys: new Set(),
  queuedTaskKeys: new Set(),
  unreadTaskKeys: new Set(),
}

export class RuntimeTaskLifecycleStore {
  private readonly machines = new Map<string, RuntimeTaskMachine>()
  private readonly listeners = new Set<Listener>()
  private readonly unreadStorageKey: string
  private currentTaskKey: string | null = null
  private persistedUnreadSerialized: string | null = null
  private version = 0
  private snapshot = EMPTY_STORE_SNAPSHOT

  constructor(userId: number | string | null | undefined) {
    this.unreadStorageKey = `wework.runtimeTaskLifecycle.${userId ?? 'anonymous'}.unread.v1`
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): RuntimeTaskLifecycleStoreSnapshot => this.snapshot

  getTask(address: RuntimeTaskAddress | null | undefined): RuntimeTaskLifecycleSnapshot | null {
    if (!address) return null
    return this.machines.get(getRuntimeTaskLifecycleKey(address))?.getSnapshot() ?? null
  }

  syncRuntimeWork(runtimeWork: RuntimeWorkListResponse | null | undefined): void {
    if (!runtimeWork) return

    let changed = false
    for (const { workspace, task } of collectRuntimeTasks(runtimeWork)) {
      const address = getRuntimeTaskAddress(workspace, task)
      changed =
        this.reduceMachine(address, {
          type: 'executor_snapshot_received',
          address,
          task,
        }) || changed
    }
    if (changed) this.publish()
  }

  syncRuntimeTask(
    address: RuntimeTaskAddress,
    task: RuntimeTaskSummary,
    expectedSnapshot?: RuntimeTaskLifecycleSnapshot | null
  ): boolean {
    if (expectedSnapshot !== undefined && this.getTask(address) !== expectedSnapshot) {
      return false
    }
    const changed = this.reduceMachine(address, {
      type: 'executor_snapshot_received',
      address,
      task,
    })
    if (changed) this.publish()
    const executionRunning = this.getTask(address)?.execution.running
    return typeof task.running !== 'boolean' || task.running === executionRunning
  }

  setCurrentTask(address: RuntimeTaskAddress | null | undefined): void {
    const nextKey = address ? getRuntimeTaskLifecycleKey(address) : null
    if (nextKey === this.currentTaskKey) return
    this.currentTaskKey = nextKey
    if (address) {
      this.dispatch(address, { type: 'marked_read' })
      return
    }
    this.publish()
  }

  sendRequested(address: RuntimeTaskAddress): void {
    this.dispatch(address, { type: 'send_requested' })
  }

  sendAccepted(address: RuntimeTaskAddress): void {
    this.dispatch(address, { type: 'send_accepted' })
  }

  sendRejected(address: RuntimeTaskAddress): void {
    this.dispatch(address, { type: 'send_rejected' })
  }

  sendBlockedByActiveTurn(address: RuntimeTaskAddress): void {
    this.dispatch(address, { type: 'send_blocked_by_active_turn' })
  }

  stopRequested(address: RuntimeTaskAddress): void {
    this.dispatch(address, { type: 'stop_requested' })
  }

  stopRejected(address: RuntimeTaskAddress): void {
    this.dispatch(address, { type: 'stop_rejected' })
  }

  executorStarted(address: RuntimeTaskAddress): void {
    this.dispatch(address, { type: 'executor_started' })
  }

  executorSettled(address: RuntimeTaskAddress): void {
    this.dispatch(address, { type: 'executor_settled' })
  }

  turnStarted(address: RuntimeTaskAddress, turnId?: string | null): void {
    this.dispatch(address, { type: 'turn_started', turnId })
  }

  turnSettled(
    address: RuntimeTaskAddress,
    turnId?: string | null,
    outcome?: 'succeeded' | 'failed' | 'cancelled'
  ): void {
    this.dispatch(address, { type: 'turn_settled', turnId, outcome })
  }

  syncTranscript(
    address: RuntimeTaskAddress,
    transcript: RuntimePaneTranscript,
    options: SyncTranscriptOptions = {}
  ): void {
    const streamingTurn = transcript.turns.findLast(
      turn => turn.status === 'pending' || turn.status === 'streaming'
    )
    const hasStreamingTurn = Boolean(streamingTurn)
    const ignoreStaleIdleTranscript =
      transcript.running === false &&
      options.preserveActiveTurn === true &&
      (this.getTask(address)?.derived.isRunning ?? false)

    if (hasStreamingTurn) {
      this.executorStarted(address)
      this.dispatch(address, {
        type: 'turn_recovered',
        streaming: true,
        turnId: streamingTurn?.id,
      })
    } else if (transcript.running === true) {
      this.executorStarted(address)
    } else if (transcript.running === false && !ignoreStaleIdleTranscript) {
      this.executorSettled(address)
      this.turnSettled(address)
    }
  }

  goalStatusReceived(address: RuntimeTaskAddress, goalStatus: RuntimeGoalStatus | null): void {
    this.dispatch(address, { type: 'goal_status_received', goalStatus })
  }

  markRead(address: RuntimeTaskAddress): void {
    this.dispatch(address, { type: 'marked_read' })
  }

  remove(address: RuntimeTaskAddress): void {
    const deleted = this.machines.delete(getRuntimeTaskLifecycleKey(address))
    if (deleted) this.publish()
  }

  rename(previous: RuntimeTaskAddress, next: RuntimeTaskAddress): void {
    const previousKey = getRuntimeTaskLifecycleKey(previous)
    const nextKey = getRuntimeTaskLifecycleKey(next)
    if (previousKey === nextKey) return

    const previousMachine = this.machines.get(previousKey)
    if (!previousMachine) return
    const previousState = previousMachine.getState()
    const nextMachine = this.ensureMachine(next)
    nextMachine.dispatch({
      type: 'executor_snapshot_received',
      address: next,
      task: previousState.task ?? emptyRuntimeTaskSummary(next),
    })
    if (previousState.goalStatus !== null) {
      nextMachine.dispatch({
        type: 'goal_status_received',
        goalStatus: previousState.goalStatus,
      })
    }
    if (previousState.executionPhase === 'starting') {
      nextMachine.dispatch({ type: 'send_requested' })
    } else if (previousState.executionPhase === 'running') {
      nextMachine.dispatch({ type: 'executor_started' })
    }
    if (previousState.turnPhase === 'streaming') {
      nextMachine.dispatch({ type: 'turn_started', turnId: previousState.activeTurnId })
    } else if (previousState.turnPhase === 'submitting') {
      nextMachine.dispatch({ type: 'send_requested' })
    } else if (previousState.turnPhase === 'awaiting') {
      nextMachine.dispatch({ type: 'send_accepted' })
    }
    if (previousState.turnOutcome) {
      nextMachine.dispatch({
        type: 'turn_settled',
        outcome: previousState.turnOutcome,
      })
    }
    if (previousState.unread) nextMachine.dispatch({ type: 'marked_unread' })
    this.machines.delete(previousKey)
    if (this.currentTaskKey === previousKey) this.currentTaskKey = nextKey
    this.publish()
  }

  private dispatch(address: RuntimeTaskAddress, event: RuntimeTaskLifecycleEvent): void {
    if (this.reduceMachine(address, event)) this.publish()
  }

  private reduceMachine(address: RuntimeTaskAddress, event: RuntimeTaskLifecycleEvent): boolean {
    const machine = this.ensureMachine(address)
    const previous = machine.getSnapshot()
    let changed = machine.dispatch(event)
    const next = machine.getSnapshot()
    if (
      previous.derived.isRunning &&
      !next.derived.isRunning &&
      !next.derived.isQueued &&
      next.goalStatus !== 'active' &&
      next.key !== this.currentTaskKey
    ) {
      changed = machine.dispatch({ type: 'marked_unread' }) || changed
    }
    if (next.derived.isRunning || next.key === this.currentTaskKey) {
      changed = machine.dispatch({ type: 'marked_read' }) || changed
    }
    return changed
  }

  private ensureMachine(address: RuntimeTaskAddress): RuntimeTaskMachine {
    const key = getRuntimeTaskLifecycleKey(address)
    const existing = this.machines.get(key)
    if (existing) return existing

    const machine = new RuntimeTaskMachine(address, this.readUnreadKeys().has(key))
    this.machines.set(key, machine)
    return machine
  }

  private publish(): void {
    const tasks = new Map<string, RuntimeTaskLifecycleSnapshot>()
    const runningTaskKeys = new Set<string>()
    const queuedTaskKeys = new Set<string>()
    const unreadTaskKeys = new Set<string>()
    for (const [key, machine] of this.machines) {
      const task = machine.getSnapshot()
      tasks.set(key, task)
      if (task.derived.isRunning) runningTaskKeys.add(key)
      if (task.derived.isQueued) queuedTaskKeys.add(key)
      if (task.derived.shouldShowUnread) unreadTaskKeys.add(key)
    }
    this.version += 1
    this.snapshot = {
      version: this.version,
      tasks,
      runningTaskKeys,
      queuedTaskKeys,
      unreadTaskKeys,
    }
    this.persistUnreadKeys(unreadTaskKeys)
    this.listeners.forEach(listener => listener())
  }

  private readUnreadKeys(): Set<string> {
    if (typeof window === 'undefined') return new Set()
    try {
      const value = JSON.parse(window.localStorage.getItem(this.unreadStorageKey) ?? '[]')
      const keys = new Set<string>(
        Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
      )
      this.persistedUnreadSerialized = serializeUnreadKeys(keys)
      return keys
    } catch {
      return new Set()
    }
  }

  private persistUnreadKeys(keys: ReadonlySet<string>): void {
    if (typeof window === 'undefined') return
    const serialized = serializeUnreadKeys(keys)
    if (serialized === this.persistedUnreadSerialized) return
    try {
      window.localStorage.setItem(this.unreadStorageKey, serialized)
      this.persistedUnreadSerialized = serialized
    } catch (error) {
      console.warn('Failed to persist runtime task unread state', error)
    }
  }
}

export function selectRuntimeTaskLifecycle(
  snapshot: RuntimeTaskLifecycleStoreSnapshot,
  address: RuntimeTaskAddress | null | undefined
): RuntimeTaskLifecycleSnapshot | null {
  if (!address) return null
  return snapshot.tasks.get(getRuntimeTaskLifecycleKey(address)) ?? null
}

function collectRuntimeTasks(
  runtimeWork: RuntimeWorkListResponse
): Array<{ workspace: RuntimeDeviceWorkspace; task: RuntimeTaskSummary }> {
  return [
    ...runtimeWork.chats,
    ...runtimeWork.projects.flatMap(project => project.deviceWorkspaces),
  ].flatMap(workspace => workspace.tasks.map(task => ({ workspace, task })))
}

function getRuntimeTaskAddress(
  workspace: RuntimeDeviceWorkspace,
  task: RuntimeTaskSummary
): RuntimeTaskAddress {
  return {
    deviceId: workspace.deviceId,
    taskId: task.taskId,
    ...(task.runtime !== 'codex' ? { runtime: task.runtime } : {}),
    threadId: task.threadId,
    workspacePath: task.workspacePath || workspace.workspacePath,
    runtimeHandle: task.runtimeHandle,
  }
}

function emptyRuntimeTaskSummary(address: RuntimeTaskAddress): RuntimeTaskSummary {
  return {
    taskId: address.taskId,
    threadId: address.threadId,
    workspacePath: address.workspacePath ?? '',
    title: address.taskId,
    runtime: address.runtime ?? 'codex',
    runtimeHandle: address.runtimeHandle,
  }
}

function serializeUnreadKeys(keys: ReadonlySet<string>): string {
  return JSON.stringify([...keys].slice(-200))
}
