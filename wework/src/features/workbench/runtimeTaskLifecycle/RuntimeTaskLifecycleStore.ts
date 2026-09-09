import type {
  RuntimeDeviceWorkspace,
  RuntimeGoalStatus,
  RuntimeTaskAddress,
  RuntimeTaskSummary,
  RuntimeWorkListResponse,
} from '@/types/api'
import type { RuntimePaneTranscript } from '@/types/workbench'
import {
  isRuntimeTaskAuthoritativeCompletion,
  normalizeRuntimeTaskSummary,
  shouldReplaceRuntimeTaskProjection,
} from './projection'
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

const RUNTIME_TASK_LIFECYCLE_READ_METHODS = new Set<PropertyKey>([
  'subscribe',
  'getSnapshot',
  'getCurrentTask',
  'getTask',
  'selectTask',
])

export class RuntimeTaskLifecycleStore {
  private readonly machines = new Map<string, RuntimeTaskMachine>()
  private readonly deviceAliases = new Map<string, string>()
  private readonly previousRunningTaskKeys: Set<string>
  private readonly listeners = new Set<Listener>()
  private readonly unreadStorageKey: string
  private readonly runningStorageKey: string
  private currentTaskKey: string | null = null
  private persistedUnreadSerialized: string | null = null
  private persistedRunningSerialized: string | null = null
  private version = 0
  private snapshot = EMPTY_STORE_SNAPSHOT

  constructor(userId: number | string | null | undefined) {
    const storageScope = `wework.runtimeTaskLifecycle.${userId ?? 'anonymous'}`
    this.unreadStorageKey = `${storageScope}.unread.v2`
    this.runningStorageKey = `${storageScope}.running.v2`
    this.previousRunningTaskKeys = readStoredTaskKeys(this.runningStorageKey)
    this.persistedRunningSerialized = serializeTaskKeys(this.previousRunningTaskKeys)
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): RuntimeTaskLifecycleStoreSnapshot => this.snapshot

  getCurrentTask(): RuntimeTaskLifecycleSnapshot | null {
    if (!this.currentTaskKey) return null
    return this.snapshot.tasks.get(this.currentTaskKey) ?? null
  }

  getTask(address: RuntimeTaskAddress | null | undefined): RuntimeTaskLifecycleSnapshot | null {
    if (!address) return null
    const canonicalAddress = this.canonicalizeAddress(address)
    return this.machines.get(getRuntimeTaskLifecycleKey(canonicalAddress))?.getSnapshot() ?? null
  }

  selectTask(
    snapshot: RuntimeTaskLifecycleStoreSnapshot,
    address: RuntimeTaskAddress | null | undefined
  ): RuntimeTaskLifecycleSnapshot | null {
    if (!address) return null
    const canonicalAddress = this.canonicalizeAddress(address)
    return snapshot.tasks.get(getRuntimeTaskLifecycleKey(canonicalAddress)) ?? null
  }

  syncRuntimeWork(runtimeWork: RuntimeWorkListResponse | null | undefined): void {
    if (!runtimeWork) return

    let changed = this.registerRuntimeWorkAliases(runtimeWork)
    for (const { workspace, task } of collectRuntimeTasks(runtimeWork)) {
      const address = getRuntimeTaskAddress(workspace, task)
      const normalizedTask = normalizeRuntimeTaskSummary(task)
      changed =
        this.reduceMachine(address, {
          type: 'executor_snapshot_received',
          address,
          task: normalizedTask,
        }) || changed
    }
    if (changed) this.publish()
  }

  syncRuntimeTask(
    address: RuntimeTaskAddress,
    task: RuntimeTaskSummary,
    expectedSnapshot?: RuntimeTaskLifecycleSnapshot | null
  ): boolean {
    const currentSnapshot = this.getTask(address)
    if (
      expectedSnapshot !== undefined &&
      runtimeTaskLifecycleTransitionChanged(expectedSnapshot, currentSnapshot)
    ) {
      return false
    }
    const normalizedTask = normalizeRuntimeTaskSummary(task)
    const changed = this.reduceMachine(address, {
      type: 'executor_snapshot_received',
      address,
      task: normalizedTask,
    })
    if (changed) this.publish()
    const executionRunning = this.getTask(address)?.execution.running
    return (
      typeof normalizedTask.running !== 'boolean' || normalizedTask.running === executionRunning
    )
  }

  syncRuntimeTranscriptSnapshot(
    address: RuntimeTaskAddress,
    transcript: {
      running?: boolean
      turns: Array<{
        id: string | null
        status?: string | null
        completedAt?: string | number | null
      }>
    }
  ): void {
    if (transcript.running === true) {
      const current = this.getTask(address)
      if (shouldIgnoreStaleRunningTranscript(current)) return
      this.executorStarted(address)
      return
    }
    if (transcript.running !== false) return

    const terminalTurn = transcript.turns.findLast(turn => isTerminalTurnStatus(turn.status))
    const completedAt = terminalTurn?.completedAt
    if (completedAt == null) return

    const currentTask = this.getTask(address)?.task
    if (!currentTask) {
      this.executorSettled(address)
      return
    }
    if (
      currentTask.completedAt != null &&
      String(currentTask.completedAt) === String(completedAt)
    ) {
      const currentTurnId = this.getTask(address)?.turn.id
      if (currentTurnId && terminalTurn?.id === currentTurnId) {
        this.executorSettled(address)
        this.turnSettled(address, currentTurnId, terminalTurnOutcome(terminalTurn.status))
      }
      return
    }

    const outcome = terminalTurnOutcome(terminalTurn?.status)
    this.syncRuntimeTask(address, {
      ...currentTask,
      running: false,
      completedAt,
      status:
        outcome === 'failed'
          ? 'failed'
          : outcome === 'cancelled'
            ? 'cancelled'
            : currentTask.status,
      turnStatus:
        outcome === 'failed' ? 'failed' : outcome === 'cancelled' ? 'interrupted' : 'completed',
    })
  }

  setCurrentTask(address: RuntimeTaskAddress | null | undefined): void {
    const canonicalAddress = address ? this.canonicalizeAddress(address) : null
    const nextKey = canonicalAddress ? getRuntimeTaskLifecycleKey(canonicalAddress) : null
    if (nextKey === this.currentTaskKey) return
    this.currentTaskKey = nextKey
    if (canonicalAddress) {
      this.dispatch(canonicalAddress, { type: 'marked_read' })
      return
    }
    this.publish()
  }

  sendRequested(
    address: RuntimeTaskAddress,
    options: { workspaceCreationKind?: string } = {}
  ): void {
    this.dispatch(address, {
      type: 'send_requested',
      ...(options.workspaceCreationKind
        ? { workspaceCreationKind: options.workspaceCreationKind }
        : {}),
    })
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
    this.syncRuntimeTranscriptSnapshot(address, transcript)
    const streamingTurn = transcript.turns.findLast(
      turn => turn.status === 'pending' || turn.status === 'streaming'
    )
    const hasStreamingTurn = Boolean(streamingTurn)
    const current = this.getTask(address)
    const ignoreStaleRunningTranscript = shouldIgnoreStaleRunningTranscript(current)
    const ignoreStaleIdleTranscript =
      transcript.running === false &&
      options.preserveActiveTurn === true &&
      (current?.derived.isRunning ?? false)

    if (hasStreamingTurn) {
      if (ignoreStaleRunningTranscript) return
      this.executorStarted(address)
      this.dispatch(address, {
        type: 'turn_recovered',
        streaming: true,
        turnId: streamingTurn?.id,
      })
    } else if (transcript.running === true) {
      if (ignoreStaleRunningTranscript) return
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
    const canonicalAddress = this.canonicalizeAddress(address)
    const key = getRuntimeTaskLifecycleKey(canonicalAddress)
    const deleted = this.machines.delete(key)
    this.previousRunningTaskKeys.delete(key)
    if (deleted) this.publish()
  }

  rename(previous: RuntimeTaskAddress, next: RuntimeTaskAddress): void {
    const canonicalPrevious = this.canonicalizeAddress(previous)
    const canonicalNext = this.canonicalizeAddress(next)
    const previousKey = getRuntimeTaskLifecycleKey(canonicalPrevious)
    const nextKey = getRuntimeTaskLifecycleKey(canonicalNext)
    if (previousKey === nextKey) return

    const previousMachine = this.machines.get(previousKey)
    if (!previousMachine) return
    this.mergeMachineIntoAddress(previousKey, previousMachine, canonicalNext)
    this.publish()
  }

  private dispatch(address: RuntimeTaskAddress, event: RuntimeTaskLifecycleEvent): void {
    if (this.reduceMachine(address, event)) this.publish()
  }

  private reduceMachine(address: RuntimeTaskAddress, event: RuntimeTaskLifecycleEvent): boolean {
    const canonicalAddress = this.canonicalizeAddress(address)
    const canonicalEvent =
      event.type === 'executor_snapshot_received' ? { ...event, address: canonicalAddress } : event
    const machine = this.ensureMachine(canonicalAddress)
    const previous = machine.getSnapshot()
    const key = previous.key
    const wasRunning = previous.derived.isRunning || this.previousRunningTaskKeys.has(key)
    if (
      canonicalEvent.type === 'executor_snapshot_received' &&
      previous.task &&
      !shouldReplaceRuntimeTaskProjection(previous.task, canonicalEvent.task)
    ) {
      return false
    }
    const eventChanged = machine.dispatch(canonicalEvent)
    let changed = eventChanged
    const next = machine.getSnapshot()
    if (
      canonicalEvent.type === 'turn_settled' &&
      previous.task?.running === true &&
      import.meta.env.VITE_WEWORK_RUNTIME_DEBUG === '1'
    ) {
      console.info('[Wework] Runtime turn settled before executor became idle', {
        deviceId: canonicalAddress.deviceId,
        taskId: canonicalAddress.taskId,
        turnId: canonicalEvent.turnId ?? previous.turn.id,
        previousExecutionPhase: previous.execution.phase,
        nextExecutionPhase: next.execution.phase,
        previousTurnPhase: previous.turn.phase,
        nextTurnPhase: next.turn.phase,
        executorSnapshotRunning: previous.task.running,
      })
    }
    if (
      wasRunning &&
      !next.derived.isRunning &&
      !next.derived.isQueued &&
      next.goalStatus !== 'active' &&
      next.key !== this.currentTaskKey
    ) {
      changed = machine.dispatch({ type: 'marked_unread' }) || changed
    }
    if (next.derived.isRunning) this.previousRunningTaskKeys.add(key)
    else this.previousRunningTaskKeys.delete(key)
    if (next.derived.isRunning || next.key === this.currentTaskKey) {
      changed = machine.dispatch({ type: 'marked_read' }) || changed
    }
    return changed
  }

  private ensureMachine(address: RuntimeTaskAddress): RuntimeTaskMachine {
    const canonicalAddress = this.canonicalizeAddress(address)
    const key = getRuntimeTaskLifecycleKey(canonicalAddress)
    const existing = this.machines.get(key)
    if (existing) return existing

    const machine = new RuntimeTaskMachine(canonicalAddress, this.readUnreadKeys().has(key))
    this.machines.set(key, machine)
    return machine
  }

  private canonicalizeAddress(address: RuntimeTaskAddress): RuntimeTaskAddress {
    const deviceId = this.resolveDeviceId(address.deviceId)
    return deviceId === address.deviceId ? address : { ...address, deviceId }
  }

  private resolveDeviceId(deviceId: string): string {
    let current = deviceId
    const visited = new Set<string>()
    while (!visited.has(current)) {
      visited.add(current)
      const next = this.deviceAliases.get(current)
      if (!next || next === current) break
      current = next
    }
    return current
  }

  private registerRuntimeWorkAliases(runtimeWork: RuntimeWorkListResponse): boolean {
    let changed = false
    for (const workspace of collectRuntimeWorkspaces(runtimeWork)) {
      const alias = workspace.remoteHostId?.trim()
      const canonicalDeviceId = workspace.deviceId.trim()
      if (!alias || !canonicalDeviceId || alias === canonicalDeviceId) continue
      changed = this.registerDeviceAlias(alias, canonicalDeviceId) || changed
    }
    return changed
  }

  private registerDeviceAlias(alias: string, canonicalDeviceId: string): boolean {
    const canonical = this.resolveDeviceId(canonicalDeviceId)
    if (this.resolveDeviceId(alias) === canonical) return false

    this.deviceAliases.set(alias, canonical)
    let changed = false
    for (const [key, machine] of [...this.machines]) {
      const address = machine.getState().address
      if (address.deviceId !== alias) continue
      const nextAddress = { ...address, deviceId: canonical }
      this.mergeMachineIntoAddress(key, machine, nextAddress)
      changed = true
    }
    return changed
  }

  private mergeMachineIntoAddress(
    previousKey: string,
    previousMachine: RuntimeTaskMachine,
    nextAddress: RuntimeTaskAddress
  ): void {
    const previousState = previousMachine.getState()
    const nextKey = getRuntimeTaskLifecycleKey(nextAddress)
    const nextMachine = this.ensureMachine(nextAddress)
    const nextTask = nextMachine.getState().task
    const previousTask = previousState.task
    if (!nextTask || (previousTask && shouldReplaceRuntimeTaskProjection(nextTask, previousTask))) {
      nextMachine.dispatch({
        type: 'executor_snapshot_received',
        address: nextAddress,
        task: previousTask ?? emptyRuntimeTaskSummary(nextAddress),
      })
    }
    if (previousState.goalStatus !== null) {
      nextMachine.dispatch({
        type: 'goal_status_received',
        goalStatus: previousState.goalStatus,
      })
    }
    const sendRequestedEvent: RuntimeTaskLifecycleEvent = {
      type: 'send_requested',
      ...(previousState.workspaceCreationKind
        ? { workspaceCreationKind: previousState.workspaceCreationKind }
        : {}),
    }
    if (previousState.executionPhase === 'starting') {
      nextMachine.dispatch(sendRequestedEvent)
    } else if (previousState.executionPhase === 'running') {
      nextMachine.dispatch({ type: 'executor_started' })
    }
    if (previousState.turnPhase === 'streaming') {
      nextMachine.dispatch({ type: 'turn_started', turnId: previousState.activeTurnId })
    } else if (previousState.turnPhase === 'submitting') {
      nextMachine.dispatch(sendRequestedEvent)
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
    if (this.previousRunningTaskKeys.delete(previousKey)) {
      this.previousRunningTaskKeys.add(nextKey)
    }
    this.machines.delete(previousKey)
    if (this.currentTaskKey === previousKey) this.currentTaskKey = nextKey
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
    this.persistRunningKeys()
    this.listeners.forEach(listener => listener())
  }

  private readUnreadKeys(): Set<string> {
    const keys = readStoredTaskKeys(this.unreadStorageKey)
    this.persistedUnreadSerialized = serializeTaskKeys(keys)
    return keys
  }

  private persistUnreadKeys(keys: ReadonlySet<string>): void {
    if (typeof window === 'undefined') return
    const serialized = serializeTaskKeys(keys)
    if (serialized === this.persistedUnreadSerialized) return
    try {
      window.localStorage.setItem(this.unreadStorageKey, serialized)
      this.persistedUnreadSerialized = serialized
    } catch (error) {
      console.warn('Failed to persist runtime task unread state', error)
    }
  }

  private persistRunningKeys(): void {
    if (typeof window === 'undefined') return
    const serialized = serializeTaskKeys(this.previousRunningTaskKeys)
    if (serialized === this.persistedRunningSerialized) return
    try {
      window.localStorage.setItem(this.runningStorageKey, serialized)
      this.persistedRunningSerialized = serialized
    } catch (error) {
      console.warn('Failed to persist runtime task running state', error)
    }
  }
}

export function createRuntimeTaskLifecycleOwnershipView(
  store: RuntimeTaskLifecycleStore,
  canWrite: () => boolean
): RuntimeTaskLifecycleStore {
  const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>()
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      const existing = methods.get(property)
      if (existing) return existing
      const method = RUNTIME_TASK_LIFECYCLE_READ_METHODS.has(property)
        ? value.bind(target)
        : (...args: unknown[]) => {
            if (!canWrite()) {
              return property === 'syncRuntimeTask' ? false : undefined
            }
            return value.apply(target, args)
          }
      methods.set(property, method)
      return method
    },
  })
}

export function runtimeTaskLifecycleTransitionChanged(
  expected: RuntimeTaskLifecycleSnapshot | null,
  current: RuntimeTaskLifecycleSnapshot | null
): boolean {
  if (!expected || !current) return expected !== current
  return (
    expected.execution.phase !== current.execution.phase ||
    expected.turn.phase !== current.turn.phase ||
    expected.turn.id !== current.turn.id ||
    expected.turn.outcome !== current.turn.outcome ||
    expected.goalStatus !== current.goalStatus ||
    expected.continuable !== current.continuable
  )
}

function shouldIgnoreStaleRunningTranscript(current: RuntimeTaskLifecycleSnapshot | null): boolean {
  return Boolean(
    current &&
    !current.derived.isRunning &&
    (current.turn.outcome !== null ||
      (current.goalStatus !== 'active' &&
        current.task !== null &&
        isRuntimeTaskAuthoritativeCompletion(current.task)))
  )
}

export function consumeRuntimeTaskLifecycleBlock(
  blockedSnapshots: Map<string, RuntimeTaskLifecycleSnapshot | null>,
  key: string,
  current: RuntimeTaskLifecycleSnapshot | null
): boolean {
  if (!blockedSnapshots.has(key)) return true
  const blocked = blockedSnapshots.get(key) ?? null
  if (!runtimeTaskLifecycleTransitionChanged(blocked, current)) return false
  blockedSnapshots.delete(key)
  return true
}

function isTerminalTurnStatus(status: string | null | undefined): boolean {
  const normalized = status?.replace(/[_-]/g, '').trim().toLowerCase()
  return Boolean(
    normalized &&
    [
      'done',
      'complete',
      'completed',
      'failed',
      'error',
      'cancelled',
      'canceled',
      'interrupted',
    ].includes(normalized)
  )
}

function terminalTurnOutcome(
  status: string | null | undefined
): 'succeeded' | 'failed' | 'cancelled' {
  const normalized = status?.replace(/[_-]/g, '').trim().toLowerCase()
  if (normalized === 'failed' || normalized === 'error') return 'failed'
  if (normalized === 'cancelled' || normalized === 'canceled' || normalized === 'interrupted') {
    return 'cancelled'
  }
  return 'succeeded'
}

function collectRuntimeTasks(
  runtimeWork: RuntimeWorkListResponse
): Array<{ workspace: RuntimeDeviceWorkspace; task: RuntimeTaskSummary }> {
  return collectRuntimeWorkspaces(runtimeWork).flatMap(workspace =>
    workspace.tasks.map(task => ({ workspace, task }))
  )
}

function collectRuntimeWorkspaces(runtimeWork: RuntimeWorkListResponse): RuntimeDeviceWorkspace[] {
  return [
    ...runtimeWork.chats,
    ...runtimeWork.projects.flatMap(project => project.deviceWorkspaces),
  ]
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

function serializeTaskKeys(keys: ReadonlySet<string>): string {
  return JSON.stringify([...keys].slice(-200))
}

function readStoredTaskKeys(storageKey: string): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const value = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]')
    return new Set(Array.isArray(value) ? value.filter(item => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}
