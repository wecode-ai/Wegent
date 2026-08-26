import type { ChatStreamHandlers } from '@/stream/chatStream'
import type { WorkbenchServices } from './workbenchServices'
import {
  createRuntimeConversationStreamHandlers,
  type RuntimeConversationStreamHandlers,
} from './runtimePaneMessages'

interface Registration {
  active: boolean
  handlers: RuntimeConversationStreamHandlers
  order: number
}

interface Coordinator {
  registrations: Map<symbol, Registration>
  nextOrder: number
}

const coordinators = new WeakMap<WorkbenchServices['chatStream'], Coordinator>()

export function registerRuntimeConversationStream(
  chatStream: WorkbenchServices['chatStream'],
  handlers: RuntimeConversationStreamHandlers,
  active: boolean
): () => void {
  const coordinator = getCoordinator(chatStream)
  const token = Symbol('runtime-conversation-stream-registration')
  coordinator.registrations.set(token, {
    active,
    handlers,
    order: coordinator.nextOrder++,
  })
  return () => {
    coordinator.registrations.delete(token)
  }
}

function getCoordinator(chatStream: WorkbenchServices['chatStream']): Coordinator {
  const existing = coordinators.get(chatStream)
  if (existing) return existing

  const coordinator: Coordinator = {
    registrations: new Map(),
    nextOrder: 1,
  }
  coordinators.set(chatStream, coordinator)
  chatStream.subscribe(createDelegatingHandlers(coordinator))
  return coordinator
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
