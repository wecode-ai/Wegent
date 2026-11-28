import type { TFunction } from 'i18next'
import type { WorkbenchServices } from './workbenchServices'
import type { WorkbenchSessionState } from './workbenchSessionState'
import type { WorkbenchSessionOperations } from './workbenchSessionOperations'
import type { AiGenerationTelemetry } from './aiGenerationTelemetryService'
import type { useWorkbenchDataRefresh } from './useWorkbenchDataRefresh'
import { retainWorkbenchServiceConnections } from './workbenchServiceConnections'
import {
  registerRuntimeConversationStream,
  type RuntimeConversationStreamRegistration,
} from './runtimeConversationStreamCoordinator'
import type { RuntimeConversationStreamHandlers } from './runtimePaneMessages'
import {
  applyRuntimeConversationSubagentActivity,
  setRuntimeConversationTaskPlan,
  settleRuntimeConversationAcceptedMessage,
  settleRuntimeConversationSubagents,
  unmarkRuntimeConversationArchived,
} from './runtimeConversationCache'
import { syncRuntimeGoal } from './runtimeTaskLifecycle/goalSynchronization'
import {
  createRuntimeWorkRefreshQueue,
  mergeRuntimeTaskAddresses,
} from './workbenchDataRefreshHelpers'
import { reportArchivedCleanupFailure } from '@/components/settings/archivedConversationsSettingsState'
import { installMainRuntimeWorkChangedListener } from '@/desktop/runtimeWorkSync'
import { installLocalWorkspaceOpenListener } from '@/desktop/localWorkspaceOpen'
import { disposeDesktopListener } from '@/desktop/disposeDesktopListener'
import type { RuntimeTaskAddress } from '@/types/api'

export interface WorkbenchStreamInput {
  services: WorkbenchServices
  t: TFunction<'common'>
  updateLocalRuntimeTaskTitle: ReturnType<
    typeof useWorkbenchDataRefresh
  >['updateLocalRuntimeTaskTitle']
  updateLocalRuntimeTaskSupervisor: ReturnType<
    typeof useWorkbenchDataRefresh
  >['updateLocalRuntimeTaskSupervisor']
}
export interface WorkbenchStreamOwner {
  state: WorkbenchSessionState
  operations: WorkbenchSessionOperations
  telemetry: AiGenerationTelemetry
  inputs(): WorkbenchStreamInput
  isHeld(): boolean
  canNavigate(): boolean
  canSyncLifecycle(): boolean
}

/** Own native parser registrations and listeners for the lifetime of an actual Workbench tab. */
export function createWorkbenchSessionStreams(owner: WorkbenchStreamOwner, tabId?: string) {
  let services: WorkbenchServices | null = null
  let registration: RuntimeConversationStreamRegistration | null = null
  let unsubscribeWork: (() => void) | null = null
  let releaseConnections: (() => void) | null = null
  let unarchivedTasks: RuntimeTaskAddress[] = []
  const refreshQueue = createRuntimeWorkRefreshQueue(() => {
    const restored = unarchivedTasks
    unarchivedTasks = []
    return owner.operations.stableRefreshWorkLists({
      refreshDevices: false,
      ...(restored.length ? { unarchivedTasks: restored } : {}),
    })
  })
  const refreshChangedWork = () => {
    if (!owner.isHeld()) return Promise.resolve()
    return refreshQueue.refresh()
  }
  const handlers: RuntimeConversationStreamHandlers = {
    onMessageAction: (...args) => {
      if (owner.isHeld()) owner.operations.applyCanonicalRuntimeAction(...args)
    },
    onGuidanceApplied: (...args) => {
      if (owner.isHeld()) owner.operations.settleCanonicalRuntimeGuidance(...args)
    },
    onAssistantStart: (address, turnId) => {
      if (!owner.isHeld()) return
      settleRuntimeConversationAcceptedMessage(address)
      owner.telemetry.onAssistantStart(address, turnId)
    },
    onAssistantFirstToken: (address, turnId) => {
      if (owner.isHeld()) owner.telemetry.onAssistantFirstToken(address, turnId)
    },
    onAssistantResponseSize: (address, turnId, bytes) => {
      if (owner.isHeld()) owner.telemetry.onAssistantResponseSize(address, turnId, bytes)
    },
    onAssistantSettled: (address, turnId, outcome, errorType) => {
      if (!owner.isHeld()) return
      settleRuntimeConversationSubagents(address)
      owner.telemetry.onAssistantSettled(
        address,
        turnId,
        outcome === 'succeeded' ? 'success' : outcome === 'failed' ? 'failure' : 'cancelled',
        undefined,
        errorType
      )
      void owner.operations.syncRuntimeTaskUntilExecutorSettles(address)
      owner.operations.syncRuntimeGoalSnapshot(address)
    },
    onContextUsageUpdated: (...args) => {
      if (owner.isHeld()) owner.operations.updateCanonicalRuntimeContextUsage(...args)
    },
    onSubagentActivity: (...args) => {
      if (owner.isHeld()) applyRuntimeConversationSubagentActivity(...args)
    },
    onRuntimeTaskTitleUpdated: (address, payload) => {
      if (!owner.isHeld()) return
      owner.inputs().updateLocalRuntimeTaskTitle(address, payload.title)
      owner.state.dispatch({ type: 'runtime_task_title_updated', address, title: payload.title })
    },
    onRuntimeGoalUpdated: (address, payload) => {
      if (!owner.isHeld()) return
      syncRuntimeGoal(owner.state.lifecycleStore, address, payload.goal ?? null)
      owner.operations.syncRuntimeTaskSnapshot(address)
    },
    onRuntimeGoalCleared: address => {
      if (!owner.isHeld()) return
      syncRuntimeGoal(owner.state.lifecycleStore, address, null)
      owner.operations.syncRuntimeTaskSnapshot(address)
    },
    onRuntimeSupervisorUpdated: (address, payload) => {
      if (owner.isHeld())
        owner.inputs().updateLocalRuntimeTaskSupervisor(address, payload.supervisor)
    },
    onRuntimePlanUpdated: (...args) => {
      if (owner.isHeld()) setRuntimeConversationTaskPlan(...args)
    },
  }
  let workspaceListener: ReturnType<typeof installLocalWorkspaceOpenListener> = null
  const releaseWorkspaceListener = () => {
    const previous = workspaceListener
    workspaceListener = null
    void previous
      ?.then(unlisten => disposeDesktopListener(unlisten, 'local workspace open'))
      .catch(error =>
        console.debug('[Wework] Local workspace listener was unavailable during cleanup', error)
      )
  }
  const workListener = installMainRuntimeWorkChangedListener(refreshChangedWork, tabId)
  function update() {
    if (!owner.canNavigate()) releaseWorkspaceListener()
    else if (!workspaceListener)
      workspaceListener = installLocalWorkspaceOpenListener(
        async (...args) => {
          if (owner.isHeld()) await owner.operations.stableOpenStandaloneWorkspace(...args)
        },
        error => {
          if (owner.isHeld()) owner.operations.stableSetWorkbenchError(error)
        }
      )
    const next = owner.inputs().services
    if (
      services?.socketClient !== next.socketClient ||
      services?.projectChatClient !== next.projectChatClient
    ) {
      const release = releaseConnections
      releaseConnections = retainWorkbenchServiceConnections(next)
      release?.()
    }
    if (services?.chatStream !== next.chatStream) {
      unsubscribeWork?.()
      unsubscribeWork = next.chatStream.subscribe({
        onRuntimeWorkChanged: payload => {
          if (!owner.isHeld()) return
          if (payload.archiveCleanup?.errors.length) {
            const { workspacePath, errors } = payload.archiveCleanup
            reportArchivedCleanupFailure(
              `${payload.deviceId ?? ''}\0${workspacePath}\0${payload.taskId}`,
              owner
                .inputs()
                .t('workbench.archived_cleanup_partial_failed', { message: errors.join('; ') })
            )
          }
          if (payload.archived === false && payload.deviceId) {
            const restored = { deviceId: payload.deviceId, taskId: payload.taskId }
            unmarkRuntimeConversationArchived(restored)
            unarchivedTasks = mergeRuntimeTaskAddresses(unarchivedTasks, [restored])
          }
          void refreshChangedWork().catch(error =>
            console.warn('[Wework] Failed to refresh changed runtime work', error)
          )
        },
      })
    }
    services = next
    if (!registration)
      registration = registerRuntimeConversationStream(
        next.chatStream,
        handlers,
        owner.canSyncLifecycle()
      )
    else registration.update(next.chatStream, handlers, owner.canSyncLifecycle())
  }
  update()
  return {
    update,
    dispose() {
      registration?.()
      registration = null
      unsubscribeWork?.()
      unsubscribeWork = null
      refreshQueue.dispose()
      releaseWorkspaceListener()
      void workListener
        ?.then(unlisten => disposeDesktopListener(unlisten, 'runtime work changed'))
        .catch(error =>
          console.debug('[Wework] Runtime work listener was unavailable during cleanup', error)
        )
      releaseConnections?.()
      releaseConnections = null
    },
  }
}
