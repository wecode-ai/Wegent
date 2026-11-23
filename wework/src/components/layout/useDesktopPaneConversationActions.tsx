import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { useCallback } from 'react'
import { CloudConnectorAuthCard, ConnectorAuthCard } from '@/components/chat/ConnectorAuthCard'
import { useLocalConnectorAuthRecovery } from '@/features/plugins/useLocalConnectorAuthRecovery'
import { updateAppPreferences } from '@/desktop/appPreferences'
import { getRuntimeTaskChatScopeKey } from '@/features/workbench/workbenchProviderHelpers'
import { requestWorkbenchComposerFocus } from '@/lib/workbenchComposerFocus'
import { useWorkbenchPaneSession } from './useWorkbenchPaneSession'
import { type TaskSupervisorConfig } from './TaskSupervisorControl'
import type {
  ModelSelectionConfig,
  RuntimeName,
  RuntimeSupervisorMode,
  RuntimeSupervisorSuggestion,
  RuntimeTaskAddress,
} from '@/types/api'
import { useWorkbenchCloudProjectContext } from './useWorkbenchCloudProjectContext'
import type { TFunction } from 'i18next'
import type { Dispatch, SetStateAction } from 'react'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
interface Input {
  workbenchVisible: boolean
  onRuntimeTaskCreated: (paneKey: string, address: RuntimeTaskAddress) => void | (() => void)
  paneActive: boolean
  paneVisible: boolean
  t: TFunction<'common'>
  currentRuntimeTask: RuntimeTaskAddress | null
  paneKey: string
  paneSession: ReturnType<typeof useWorkbenchPaneSession>
  sendPaneInput: ReturnType<typeof useWorkbenchPaneSession>['send']
  getDraftEditVersion: ReturnType<typeof useWorkbenchPaneSession>['getDraftEditVersion']
  pendingSupervisorConfig: TaskSupervisorConfig | null
  setPendingSupervisorConfig: Dispatch<SetStateAction<TaskSupervisorConfig | null>>
  prepareSubmission: ReturnType<typeof useWorkbenchCloudProjectContext>['prepareSubmission']
  runtimeWorkApi: WorkbenchServices['runtimeWorkApi']
}
export function useDesktopPaneConversationActions({
  workbenchVisible,
  onRuntimeTaskCreated,
  paneActive,
  paneVisible,
  t,
  currentRuntimeTask,
  paneKey,
  paneSession,
  sendPaneInput,
  getDraftEditVersion,
  pendingSupervisorConfig,
  setPendingSupervisorConfig,
  prepareSubmission,
  runtimeWorkApi,
}: Input) {
  const setSupervisorForAddress = useCallback(
    async (address: RuntimeTaskAddress, config: TaskSupervisorConfig) => {
      if (!runtimeWorkApi) return null
      const response = await runtimeWorkApi.setRuntimeSupervisor({
        address,
        mode: config.mode,
        instructions: config.instructions,
        modelSelection: config.modelSelection,
        intervalSeconds: config.intervalSeconds,
      })
      if (!response.accepted) {
        throw new Error(response.error || t('workbench.supervisor_set_failed'))
      }
      return response.supervisor
    },
    [runtimeWorkApi, t]
  )
  const sendPaneInputWithContext = useCallback(
    async (
      value?: string,
      options?: {
        guideWhenBusy?: boolean
        interruptWhenBusy?: boolean
        runtime?: RuntimeName
        runtimeExecutablePath?: string
        runtimePermissionMode?: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'
        modelSelection?: ModelSelectionConfig | null
        wegentTeamId?: number
      }
    ) => {
      const sourcePaneKey = paneKey
      const supervisorConfig =
        currentRuntimeTask || options?.runtime === 'claude_code' ? null : pendingSupervisorConfig
      const description = value ?? paneSession.input
      const draftEditVersion = getDraftEditVersion()
      const cloudSubmission = prepareSubmission(description)
      const discardTransfers: Array<() => void> = []
      try {
        const accepted = await sendPaneInput(value, {
          ...options,
          draftEditVersion,
          additionalContext: cloudSubmission.additionalContext,
          cloudProjectId: cloudSubmission.cloudProjectId,
          origin: cloudSubmission.origin,
          initialSupervisor: supervisorConfig,
          onRuntimeTaskCreated: address => {
            const discard = onRuntimeTaskCreated(sourcePaneKey, address)
            if (discard) discardTransfers.push(discard)
            cloudSubmission.onRuntimeTaskCreated(address)
            requestWorkbenchComposerFocus(getRuntimeTaskChatScopeKey(address))
          },
          onRuntimeTaskReady: () => {
            if (supervisorConfig) {
              setPendingSupervisorConfig(null)
            }
          },
        })
        if (accepted === false) for (const discard of discardTransfers) discard()
        return accepted
      } catch (error) {
        for (const discard of discardTransfers) discard()
        throw error
      }
    },
    [
      paneKey,
      currentRuntimeTask,
      pendingSupervisorConfig,
      paneSession.input,
      getDraftEditVersion,
      prepareSubmission,
      sendPaneInput,
      onRuntimeTaskCreated,
      setPendingSupervisorConfig,
    ]
  )
  const cloudConnection = useOptionalCloudConnection()
  const connectorAuthRecovery = useLocalConnectorAuthRecovery({
    active: paneActive && paneVisible && workbenchVisible,
    onError: message => paneSession.setError(message),
    messages: paneSession.messages,
    cloudConnection: {
      apiBaseUrl: cloudConnection.apiBaseUrl,
      token: cloudConnection.token,
    },
    onResumeSend: async input => {
      await paneSession.sendContinuation(input)
    },
  })

  const connectorAuthCard = connectorAuthRecovery.pending ? (
    connectorAuthRecovery.pending.cloud ? (
      <CloudConnectorAuthCard
        slug={connectorAuthRecovery.pending.cloud.slug}
        apiBaseUrl={cloudConnection.apiBaseUrl}
        token={cloudConnection.token}
        onSuccess={() => {
          void connectorAuthRecovery.completePending()
        }}
        onCancel={connectorAuthRecovery.clearPending}
      />
    ) : (
      <ConnectorAuthCard
        target={connectorAuthRecovery.pending.target}
        title={connectorAuthRecovery.pending.title}
        onSuccess={() => {
          void connectorAuthRecovery.completePending()
        }}
        onCancel={connectorAuthRecovery.clearPending}
      />
    )
  ) : null

  const submitPaneInput = useCallback(
    async (
      value?: string,
      options?: {
        guideWhenBusy?: boolean
        interruptWhenBusy?: boolean
        runtime?: RuntimeName
        runtimeExecutablePath?: string
        runtimePermissionMode?: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'
        modelSelection?: ModelSelectionConfig | null
        wegentTeamId?: number
      }
    ) => {
      connectorAuthRecovery.clearPending()
      return sendPaneInputWithContext(value, options)
    },
    [connectorAuthRecovery, sendPaneInputWithContext]
  )
  const setTaskSupervisor = useCallback(
    async (
      mode: RuntimeSupervisorMode,
      instructions: string,
      modelSelection: ModelSelectionConfig | null,
      intervalSeconds: number
    ) => {
      const config = {
        mode,
        instructions,
        modelSelection,
        intervalSeconds,
      }
      if (!currentRuntimeTask) {
        setPendingSupervisorConfig(config)
        await updateAppPreferences({
          ...(modelSelection ? { supervisorModelSelection: modelSelection } : {}),
          supervisorIntervalSeconds: intervalSeconds,
        })
        return null
      }
      const nextSupervisor = await setSupervisorForAddress(currentRuntimeTask, config)
      await updateAppPreferences({
        ...(modelSelection ? { supervisorModelSelection: modelSelection } : {}),
        supervisorIntervalSeconds: intervalSeconds,
      })
      return nextSupervisor
    },
    [currentRuntimeTask, setPendingSupervisorConfig, setSupervisorForAddress]
  )
  const clearTaskSupervisor = useCallback(async () => {
    if (!currentRuntimeTask) {
      setPendingSupervisorConfig(null)
      return
    }
    if (!runtimeWorkApi) return
    const response = await runtimeWorkApi.clearRuntimeSupervisor({
      address: currentRuntimeTask,
    })
    if (!response.accepted) {
      throw new Error(response.error || t('workbench.supervisor_clear_failed'))
    }
  }, [currentRuntimeTask, runtimeWorkApi, setPendingSupervisorConfig, t])
  const runTaskSupervisorNow = useCallback(async () => {
    if (!currentRuntimeTask || !runtimeWorkApi) return null
    const response = await runtimeWorkApi.runRuntimeSupervisorNow({
      address: currentRuntimeTask,
    })
    if (!response.accepted) {
      throw new Error(response.error || t('workbench.supervisor_run_now_failed'))
    }
    return response.supervisor
  }, [currentRuntimeTask, runtimeWorkApi, t])
  const resolveTaskSupervisorSuggestion = useCallback(
    async (suggestion: RuntimeSupervisorSuggestion, status: 'accepted' | 'dismissed') => {
      if (!currentRuntimeTask || !runtimeWorkApi) return
      if (status === 'accepted') {
        await submitPaneInput(suggestion.message, { guideWhenBusy: true })
      }
      const response = await runtimeWorkApi.resolveRuntimeSupervisor({
        address: currentRuntimeTask,
        suggestionId: suggestion.id,
        status,
      })
      if (!response.accepted) {
        throw new Error(response.error || t('workbench.supervisor_resolve_failed'))
      }
    },
    [currentRuntimeTask, runtimeWorkApi, submitPaneInput, t]
  )
  return {
    connectorAuthCard,
    submitPaneInput,
    setTaskSupervisor,
    clearTaskSupervisor,
    runTaskSupervisorNow,
    resolveTaskSupervisorSuggestion,
  }
}
