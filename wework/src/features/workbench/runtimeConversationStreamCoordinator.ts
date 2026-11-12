import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'
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
  sourceStream: WorkbenchServices['chatStream'] | null
  unsubscribe: (() => void) | null
}

const coordinator: Coordinator = {
  registrations: new Map(),
  nextOrder: 1,
  sourceStream: null,
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
  logCoordinatorStage('registered')
  return () => {
    coordinator.registrations.delete(token)
    ensureSubscription()
    logCoordinatorStage('unregistered')
  }
}

function ensureSubscription(): void {
  const source = preferredRegistration()
  if (coordinator.unsubscribe && coordinator.sourceStream === source?.chatStream) return
  disposeSubscription()
  if (!source) return
  coordinator.sourceStream = source.chatStream
  coordinator.unsubscribe = source.chatStream.subscribe(createDelegatingHandlers(coordinator))
}

function disposeSubscription(): void {
  coordinator.unsubscribe?.()
  coordinator.unsubscribe = null
  coordinator.sourceStream = null
}

function preferredRegistration(): Registration | null {
  let selected: Registration | null = null
  for (const registration of coordinator.registrations.values()) {
    if (selected && Number(selected.active) > Number(registration.active)) {
      continue
    }
    if (
      selected &&
      selected.active === registration.active &&
      selected.order > registration.order
    ) {
      continue
    }
    selected = registration
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
    onAssistantSettled: (...args) => {
      logCoordinatorStage('assistant-settled', { taskId: args[0].taskId, turnId: args[1] })
      activeHandlers(coordinator)?.onAssistantSettled?.(...args)
    },
    onContextUsageUpdated: (...args) =>
      activeHandlers(coordinator)?.onContextUsageUpdated?.(...args),
    onSubagentActivity: (...args) => activeHandlers(coordinator)?.onSubagentActivity?.(...args),
    onRuntimeTaskTitleUpdated: (...args) =>
      activeHandlers(coordinator)?.onRuntimeTaskTitleUpdated?.(...args),
    onRuntimeGoalUpdated: (...args) => activeHandlers(coordinator)?.onRuntimeGoalUpdated?.(...args),
    onRuntimeGoalCleared: (...args) => activeHandlers(coordinator)?.onRuntimeGoalCleared?.(...args),
    onRuntimeSupervisorUpdated: (...args) =>
      activeHandlers(coordinator)?.onRuntimeSupervisorUpdated?.(...args),
    onRuntimeTurnUpdated: (...args) => activeHandlers(coordinator)?.onRuntimeTurnUpdated?.(...args),
    onRuntimePlanUpdated: (...args) => activeHandlers(coordinator)?.onRuntimePlanUpdated?.(...args),
    onRuntimeTransportReplaced: (...args) =>
      activeHandlers(coordinator)?.onRuntimeTransportReplaced?.(...args),
  })
}

function logCoordinatorStage(action: string, details: Record<string, unknown> = {}): void {
  if (import.meta.env.VITE_WEWORK_E2E !== 'true') return
  logRuntimeTaskCreateStage('runtime-stream-owner', {
    action,
    registrations: coordinator.registrations.size,
    activeRegistrations: [...coordinator.registrations.values()].filter(entry => entry.active)
      .length,
    sourceOrder: preferredRegistration()?.order ?? null,
    subscribed: coordinator.unsubscribe !== null,
    ...details,
  })
}
