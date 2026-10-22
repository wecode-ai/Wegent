import type { RuntimeTaskAddress } from '@/types/api'
import type { RuntimePaneQueuedMessage } from '@/types/workbench'
import {
  appendAcceptedRuntimeConversationMessage,
  beginRuntimeConversationOperation,
  cacheRuntimeConversationQueuedMessages,
  cacheRuntimeConversationQueuePaused,
  getRuntimeConversationQueuedMessages,
  getRuntimeConversationQueuePaused,
  getRuntimeConversationQueueDiagnosticSnapshotByKey,
  runtimeConversationKey,
  runtimeConversationMessageHasStartedTurn,
  settleRuntimeConversationAcceptedMessage,
  subscribeRuntimeConversation,
} from './runtimeConversationCache'
import { isRuntimeTaskBusyError } from './runtimePaneStatus'
import { logRuntimeQueueStage } from './runtimeQueueDiagnostics'
import {
  createRuntimeQueuedUserMessage,
  retainRuntimeQueuedMessage,
  sendRuntimeQueuedMessage,
  type RuntimeQueuedMessageSenderDependencies,
} from './runtimeQueuedMessageSender'
import {
  consumeRuntimeTaskLifecycleBlock,
  runtimeTaskLifecycleTransitionChanged,
  type RuntimeTaskLifecycleSnapshot,
} from './runtimeTaskLifecycle'
import type { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle/RuntimeTaskLifecycleStore'

interface QueueDependencies extends RuntimeQueuedMessageSenderDependencies {
  lifecycleStore: RuntimeTaskLifecycleStore
}

type ConversationOperation = ReturnType<typeof beginRuntimeConversationOperation>

// Hidden React Activity trees can retain a controller after effect cleanup. Preserve that
// identity without retaining drained tasks that no view or subscription still references.
const controllers = new Map<string, WeakRef<RuntimeConversationQueueController>>()
const collectedControllers = new FinalizationRegistry<string>(key => {
  if (!controllers.get(key)?.deref()) controllers.delete(key)
})

export function getRuntimeConversationQueueController(address: RuntimeTaskAddress) {
  const key = runtimeConversationKey(address)
  let controller = controllers.get(key)?.deref()
  if (!controller) {
    controller = new RuntimeConversationQueueController(address)
    controllers.set(key, new WeakRef(controller))
    collectedControllers.register(controller, key)
  }
  controller.address = address
  return controller
}

export function resetRuntimeConversationQueueControllersForTests(): void {
  for (const controller of controllers.values()) controller.deref()?.dispose()
  controllers.clear()
}

// A pending queue owns its subscriptions and transport until it drains. Pane cleanup only
// detaches the view; it cannot stop an already enrolled task from advancing.
class RuntimeConversationQueueController {
  readonly busyBlocks = new Map<string, RuntimeTaskLifecycleSnapshot | null>()
  private bindings = new Map<symbol, QueueDependencies>()
  private dependencies: QueueDependencies | null = null
  private unsubscribeConversation: (() => void) | null = null
  private unsubscribeLifecycle: (() => void) | null = null
  private scheduled = false
  private inFlight: ConversationOperation | null = null
  private cancellationOperation: ConversationOperation | null = null
  private pauseRevision = 0
  private lastDispatchDiagnostic: string | null = null
  private pendingResume: {
    previousLifecycle: RuntimeTaskLifecycleSnapshot | null
    observedManualTurn: boolean
    operation: ConversationOperation
  } | null = null

  address: RuntimeTaskAddress

  constructor(address: RuntimeTaskAddress) {
    this.address = address
  }

  attach(dependencies: QueueDependencies): () => void {
    const token = Symbol('runtime-task-queue')
    this.bindings.set(token, dependencies)
    this.useDependencies(dependencies)
    this.unsubscribeConversation ??= subscribeRuntimeConversation(this.address, this.schedule)
    this.log('queue-controller-attached', null)
    this.schedule()
    return () => {
      this.bindings.delete(token)
      const remaining = [...this.bindings.values()].at(-1)
      if (remaining) this.useDependencies(remaining)
      this.log('queue-controller-detached', null)
      const snapshot = getRuntimeConversationQueueDiagnosticSnapshotByKey(
        runtimeConversationKey(this.address)
      )
      if (this.bindings.size === 0 && (this.inFlight || snapshot.queueLength > 0)) {
        this.log('queue-controller-retained', null)
      }
      this.disposeIfUnused()
    }
  }

  resumeAfterTurn(previousLifecycle: RuntimeTaskLifecycleSnapshot | null): void {
    this.cancelResumeAfterTurn()
    this.pendingResume = {
      previousLifecycle,
      observedManualTurn: false,
      operation: beginRuntimeConversationOperation(this.address),
    }
  }

  cancelResumeAfterTurn(): void {
    this.pauseRevision += 1
    this.pendingResume?.operation.dispose()
    this.pendingResume = null
    this.cancellationOperation?.dispose()
    this.cancellationOperation = null
  }

  pauseForCancellation(): () => void {
    const previousPaused = getRuntimeConversationQueuePaused(this.address)
    const previousResume = this.pendingResume
    this.cancelResumeAfterTurn()
    const shouldPause =
      previousResume ||
      this.messages().some(
        message =>
          !message.runtimeQueued && (message.status === 'queued' || message.status === 'sending')
      )
    if (!previousPaused && !shouldPause) return () => {}
    const operation = beginRuntimeConversationOperation(this.address)
    this.cancellationOperation = operation
    const revision = this.pauseRevision
    cacheRuntimeConversationQueuePaused(this.address, true)
    return () => {
      if (
        this.pauseRevision !== revision ||
        !operation.isCurrent() ||
        !getRuntimeConversationQueuePaused(this.address)
      )
        return
      this.cancelResumeAfterTurn()
      if (previousResume) {
        this.pendingResume = {
          ...previousResume,
          operation: beginRuntimeConversationOperation(this.address),
        }
      }
      cacheRuntimeConversationQueuePaused(this.address, previousPaused)
      this.schedule()
    }
  }

  async send(message: RuntimePaneQueuedMessage): Promise<void> {
    this.clearInvalidatedRequest()
    const dependencies = this.dependencies
    if (!dependencies || this.inFlight) {
      this.log('queue-send-skipped', message, {
        reason: dependencies ? 'request-in-flight' : 'no-transport',
      })
      return
    }
    const messages = this.messages()
    const current = messages.find(item => item.id === message.id)
    if (!current || current.runtimeQueued) {
      this.log('queue-send-skipped', message, {
        reason: current ? 'executor-queued' : 'message-missing',
      })
      return
    }
    const blockingMessages = messages.filter(
      item =>
        item.status === 'sending' && (item.id !== message.id || item.deliveryMode === 'message')
    )
    if (blockingMessages.length > 0) {
      this.log('queue-send-skipped', message, {
        reason: 'message-sending',
        blockingMessageIds: blockingMessages.slice(0, 10).map(item => item.id),
      })
      return
    }
    // Claim synchronously before transport preparation can yield or notify other views.
    this.cancelCancellationRollback()
    const operation = beginRuntimeConversationOperation(this.address)
    this.inFlight = operation
    this.update(message.id, {
      status: 'sending',
      deliveryMode: 'message',
      awaitingTurnStart: false,
    })
    this.log('queue-send-start', message)
    const before = dependencies.lifecycleStore.getTask(this.address)
    let sendError: string | null = null
    try {
      const result = await sendRuntimeQueuedMessage(this.address, message, dependencies, {
        isCurrent: operation.isCurrent,
        initialGoal: message.initialGoal,
        onError: error => {
          sendError = error
        },
      })
      if (!operation.isCurrent()) return
      this.log('queue-send-result', message, {
        accepted: result.accepted,
        runtimeQueued: result.queued,
        queuePosition: result.queuePosition ?? null,
        busyError: isRuntimeTaskBusyError(sendError),
      })
      if (result.queued) {
        this.busyBlocks.delete(message.id)
        this.log('queue-send-writeback', message, {
          runtimeQueued: true,
          lifecyclePresent: dependencies.lifecycleStore.getTask(this.address) !== null,
        })
        retainRuntimeQueuedMessage(this.address, message, result.queuePosition)
      } else if (result.accepted) {
        this.busyBlocks.delete(message.id)
        if (runtimeConversationMessageHasStartedTurn(this.address, message.id)) {
          settleRuntimeConversationAcceptedMessage(this.address, message.id)
        } else {
          this.update(message.id, { awaitingTurnStart: true })
        }
      } else {
        this.recordFailure(message.id, sendError, before)
      }
    } catch {
      if (!operation.isCurrent()) return
      this.busyBlocks.delete(message.id)
      this.log('queue-send-error', message)
      this.update(message.id, { status: 'failed', awaitingTurnStart: undefined, error: '发送失败' })
    } finally {
      operation.dispose()
      if (this.inFlight === operation) this.inFlight = null
      this.schedule()
    }
  }

  private useDependencies(dependencies: QueueDependencies): void {
    if (this.dependencies?.lifecycleStore !== dependencies.lifecycleStore) {
      this.unsubscribeLifecycle?.()
      this.unsubscribeLifecycle = dependencies.lifecycleStore.subscribe(this.schedule)
    }
    this.dependencies = dependencies
  }

  private schedule = (): void => {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.pump()
    })
  }

  private pump(): void {
    if (!this.dependencies) return
    this.clearInvalidatedRequest()
    const lifecycle = this.dependencies?.lifecycleStore.getTask(this.address) ?? null
    this.reconcileStartedMessages(lifecycle)
    this.resumeAfterManualTurn(lifecycle)
    if (this.disposeIfUnused()) return
    if (this.inFlight) {
      this.observeDispatch('request-in-flight', lifecycle)
      return
    }
    const messages = this.messages()
    if (getRuntimeConversationQueuePaused(this.address)) {
      this.observeDispatch('paused', lifecycle)
      return
    }
    if (messages.some(message => message.status === 'sending')) {
      this.observeDispatch('message-sending', lifecycle)
      return
    }
    const next = messages.find(message => message.status === 'queued' && !message.runtimeQueued)
    if (!next || !consumeRuntimeTaskLifecycleBlock(this.busyBlocks, next.id, lifecycle)) {
      this.observeDispatch(next ? 'busy-retry-blocked' : 'no-local-queued-message', lifecycle)
      return
    }
    const canStartGoal = Boolean(next.initialGoal) && !lifecycle?.derived.isTurnActive
    if (!lifecycle?.continuable || (lifecycle.derived.isBusy && !canStartGoal)) {
      this.observeDispatch(lifecycle?.continuable ? 'task-busy' : 'not-continuable', lifecycle)
      return
    }
    this.observeDispatch('ready', lifecycle)
    void this.send(next)
  }

  private reconcileStartedMessages(lifecycle: RuntimeTaskLifecycleSnapshot | null): void {
    for (const message of this.messages()) {
      if (
        message.status === 'sending' &&
        message.deliveryMode === 'message' &&
        message.awaitingTurnStart &&
        runtimeConversationMessageHasStartedTurn(this.address, message.id)
      ) {
        settleRuntimeConversationAcceptedMessage(this.address, message.id)
      }
    }
    const started = this.messages().filter(
      message =>
        message.runtimeQueued && runtimeConversationMessageHasStartedTurn(this.address, message.id)
    )
    if (started.length === 0) return
    for (const message of started) {
      appendAcceptedRuntimeConversationMessage(
        this.address,
        createRuntimeQueuedUserMessage(message),
        lifecycle?.turn.id ?? null,
        new Set(message.runtimeTurnIdsBeforeStart ?? [])
      )
    }
    const ids = new Set(started.map(message => message.id))
    cacheRuntimeConversationQueuedMessages(
      this.address,
      this.messages().filter(message => !ids.has(message.id))
    )
  }

  private resumeAfterManualTurn(lifecycle: RuntimeTaskLifecycleSnapshot | null): void {
    const pending = this.pendingResume
    if (!pending) return
    if (!pending.operation.isCurrent()) {
      pending.operation.dispose()
      this.pendingResume = null
      return
    }
    if (!lifecycle) return
    if (!pending.observedManualTurn) {
      const previous = pending.previousLifecycle?.turn
      if (
        previous &&
        previous.id === lifecycle.turn.id &&
        previous.phase === lifecycle.turn.phase &&
        previous.outcome === lifecycle.turn.outcome
      ) {
        return
      }
      pending.observedManualTurn = true
    }
    if (lifecycle.turn.phase === 'streaming' || lifecycle.turn.outcome === null) return
    pending.operation.dispose()
    this.pendingResume = null
    cacheRuntimeConversationQueuePaused(this.address, false)
  }

  private recordFailure(
    id: string,
    error: string | null,
    before: RuntimeTaskLifecycleSnapshot | null
  ): void {
    const busy = isRuntimeTaskBusyError(error)
    const after = this.dependencies?.lifecycleStore.getTask(this.address) ?? null
    if (busy && !runtimeTaskLifecycleTransitionChanged(before, after)) {
      this.busyBlocks.set(id, before)
    } else {
      this.busyBlocks.delete(id)
    }
    this.update(id, {
      status: busy ? 'queued' : 'failed',
      awaitingTurnStart: undefined,
      error: busy ? undefined : '发送失败',
    })
  }

  private messages(): RuntimePaneQueuedMessage[] {
    return getRuntimeConversationQueuedMessages(this.address)
  }

  private update(id: string, update: Partial<RuntimePaneQueuedMessage>): void {
    cacheRuntimeConversationQueuedMessages(
      this.address,
      this.messages().map(message => (message.id === id ? { ...message, ...update } : message))
    )
  }

  private disposeIfUnused(): boolean {
    if (this.bindings.size > 0 || this.inFlight || this.messages().length > 0) return false
    this.dispose()
    return true
  }

  dispose(): void {
    const hadSubscriptions = Boolean(
      this.dependencies || this.unsubscribeConversation || this.unsubscribeLifecycle
    )
    this.unsubscribeConversation?.()
    this.unsubscribeLifecycle?.()
    this.unsubscribeConversation = null
    this.unsubscribeLifecycle = null
    this.dependencies = null
    this.bindings.clear()
    this.inFlight?.dispose()
    this.inFlight = null
    this.cancelResumeAfterTurn()
    this.busyBlocks.clear()
    this.lastDispatchDiagnostic = null
    if (hadSubscriptions) this.log('queue-controller-disposed', null)
  }

  private clearInvalidatedRequest(): void {
    if (!this.inFlight || this.inFlight.isCurrent()) return
    this.inFlight.dispose()
    this.inFlight = null
    this.busyBlocks.clear()
  }

  private cancelCancellationRollback(): void {
    this.pauseRevision += 1
    this.cancellationOperation?.dispose()
    this.cancellationOperation = null
  }

  private observeDispatch(reason: string, lifecycle: RuntimeTaskLifecycleSnapshot | null): void {
    const details = {
      reason,
      bindingCount: this.bindings.size,
      inFlight: this.inFlight !== null,
      pendingResume: this.pendingResume !== null,
      lifecyclePresent: lifecycle !== null,
      executionPhase: lifecycle?.execution.phase ?? null,
      turnPhase: lifecycle?.turn.phase ?? null,
      turnId: lifecycle?.turn.id ?? null,
      turnOutcome: lifecycle?.turn.outcome ?? null,
      ...getRuntimeConversationQueueDiagnosticSnapshotByKey(runtimeConversationKey(this.address)),
    }
    const signature = JSON.stringify(details)
    if (signature === this.lastDispatchDiagnostic) return
    this.lastDispatchDiagnostic = signature
    this.log('queue-dispatch-state', null, details)
  }

  private log(
    stage: string,
    message: RuntimePaneQueuedMessage | null,
    details: Record<string, unknown> = {}
  ): void {
    logRuntimeQueueStage(this.address, stage, {
      owner: 'task-queue',
      messageId: message?.id ?? null,
      bindingCount: this.bindings.size,
      inFlight: this.inFlight !== null,
      pendingResume: this.pendingResume !== null,
      lifecycleSubscribed: this.unsubscribeLifecycle !== null,
      conversationSubscribed: this.unsubscribeConversation !== null,
      ...details,
    })
  }
}
