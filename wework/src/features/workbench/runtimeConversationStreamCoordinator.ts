import type { ChatStreamHandlers } from '@/stream/chatStream'
import type { WorkbenchServices } from './workbenchServices'
import {
  createRuntimeConversationStreamHandlers,
  type RuntimeConversationStreamHandlers,
} from './runtimePaneMessages'

interface Registration {
  active: boolean
  chatStream: WorkbenchServices['chatStream']
  handlers: RuntimeConversationStreamHandlers
  order: number
}

interface Coordinator {
  registrations: Map<symbol, Registration>
  nextOrder: number
  sourceToken: symbol | null
  unsubscribe: (() => void) | null
}

const coordinator: Coordinator = {
  registrations: new Map(),
  nextOrder: 1,
  sourceToken: null,
  unsubscribe: null,
}

export function registerRuntimeConversationStream(
  chatStream: WorkbenchServices['chatStream'],
  handlers: RuntimeConversationStreamHandlers,
  active: boolean
): () => void {
  const token = Symbol('runtime-conversation-stream-registration')
  coordinator.registrations.set(token, {
    active,
    chatStream,
    handlers,
    order: coordinator.nextOrder++,
  })
  ensureSubscription()
  return () => {
    coordinator.registrations.delete(token)
    if (coordinator.sourceToken === token) {
      replaceSubscription()
    } else if (coordinator.registrations.size === 0) {
      disposeSubscription()
    }
  }
}

function ensureSubscription(): void {
  if (coordinator.unsubscribe) return
  const source = preferredRegistration()
  if (!source) return
  coordinator.sourceToken = source.token
  coordinator.unsubscribe = source.registration.chatStream.subscribe(
    createDelegatingHandlers(coordinator)
  )
}

function replaceSubscription(): void {
  disposeSubscription()
  ensureSubscription()
}

function disposeSubscription(): void {
  coordinator.unsubscribe?.()
  coordinator.unsubscribe = null
  coordinator.sourceToken = null
}

function preferredRegistration(): { token: symbol; registration: Registration } | null {
  let selected: { token: symbol; registration: Registration } | null = null
  for (const [token, registration] of coordinator.registrations) {
    if (selected && Number(selected.registration.active) > Number(registration.active)) {
      continue
    }
    if (
      selected &&
      selected.registration.active === registration.active &&
      selected.registration.order > registration.order
    ) {
      continue
    }
    selected = { token, registration }
  }
  return selected
}

function activeHandlers(coordinator: Coordinator): RuntimeConversationStreamHandlers | undefined {
  let selected: Registration | undefined
  for (const registration of coordinator.registrations.values()) {
    if (!registration.active || (selected && selected.order > registration.order)) continue
    selected = registration
  }
  return selected?.handlers
}

function createDelegatingHandlers(coordinator: Coordinator): ChatStreamHandlers {
  return createRuntimeConversationStreamHandlers({
    onMessageAction: (...args) => activeHandlers(coordinator)?.onMessageAction(...args),
    onGuidanceApplied: (...args) => activeHandlers(coordinator)?.onGuidanceApplied?.(...args),
    onAssistantStart: (...args) => activeHandlers(coordinator)?.onAssistantStart?.(...args),
    onAssistantFirstToken: (...args) =>
      activeHandlers(coordinator)?.onAssistantFirstToken?.(...args),
    onAssistantResponseSize: (...args) =>
      activeHandlers(coordinator)?.onAssistantResponseSize?.(...args),
    onAssistantSettled: (...args) => activeHandlers(coordinator)?.onAssistantSettled?.(...args),
    onContextUsageUpdated: (...args) =>
      activeHandlers(coordinator)?.onContextUsageUpdated?.(...args),
    onSubagentActivity: (...args) => activeHandlers(coordinator)?.onSubagentActivity?.(...args),
    onRuntimeTaskTitleUpdated: (...args) =>
      activeHandlers(coordinator)?.onRuntimeTaskTitleUpdated?.(...args),
    onRuntimeGoalUpdated: (...args) => activeHandlers(coordinator)?.onRuntimeGoalUpdated?.(...args),
    onRuntimeGoalCleared: (...args) => activeHandlers(coordinator)?.onRuntimeGoalCleared?.(...args),
    onRuntimeSupervisorUpdated: (...args) =>
      activeHandlers(coordinator)?.onRuntimeSupervisorUpdated?.(...args),
    onRuntimeGoalContinuation: (...args) =>
      activeHandlers(coordinator)?.onRuntimeGoalContinuation?.(...args),
    onRuntimePlanUpdated: (...args) => activeHandlers(coordinator)?.onRuntimePlanUpdated?.(...args),
    onRuntimeTransportReplaced: (...args) =>
      activeHandlers(coordinator)?.onRuntimeTransportReplaced?.(...args),
  })
}
