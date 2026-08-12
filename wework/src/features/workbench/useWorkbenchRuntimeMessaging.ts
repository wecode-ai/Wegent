import { useCallback } from 'react'
import type { Dispatch } from 'react'
import { ApiError } from '@/api/http'
import { WEWORK_CLIENT_ORIGIN } from '@/api/backend/backendServices'
import type { ExecutorClient } from '@/api/executorAccess'
import i18n from '@/i18n'
import { appendCodeCommentContexts } from '@/lib/code-comment-context'
import { getPreferredStandaloneDeviceId } from '@/lib/device-selection'
import {
  WEWORK_MIN_EXECUTOR_VERSION,
  isDeviceBelowWeWorkVersion,
  isWeWorkCompatibleDevice,
} from '@/lib/device-capabilities'
import { supportsGitWorktreeExecution } from '@/lib/projectClassification'
import { localRuntimeAttachments, remoteAttachmentIds } from '@/lib/runtime-attachments'
import { normalizeRuntimeWorkspacePath, runtimeProjectUiId } from '@/lib/runtime-project'
import { notifyMainRuntimeWorkChanged } from '@/tauri/runtimeWorkSync'
import type { AppPreferences } from '@/tauri/appPreferences'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import {
  findWorkbenchDevice,
  getActiveWorkbenchDeviceId,
  getWorkbenchDeviceDisplayName,
  getWorkbenchDeviceUnavailableDisplayName,
  isWorkbenchDeviceOnline,
} from '@/lib/workbench-device'
import type {
  Attachment,
  ChatSendPayload,
  ModelType,
  ModelSelectionConfig,
  ModelOptions,
  ProjectWithTasks,
  RuntimeGuidanceRequest,
  RuntimeRollbackRequest,
  RuntimeTaskSummary,
  RuntimeDeviceWorkspace,
  RuntimeSendRequest,
  RuntimeTaskAddress,
  RuntimeTaskCreateRequest,
  RuntimeTaskFriendlyTitleConfig,
  SkillRef,
  TurnFileChangesSummary,
  UnifiedModel,
} from '@/types/api'
import type { WorkbenchMessage, WorkbenchState } from '@/types/workbench'
import { normalizeTurnFileChanges } from './turnFileChanges'
import type {
  CreateProjectRuntimeTaskOptions,
  CreateTemporaryRuntimeTaskOptions,
  RuntimePaneActionOptions,
  RuntimePaneGuidanceResult,
  SendCurrentInputOptions,
} from './workbenchContextTypes'
import {
  DEVICE_STATUS_LABELS,
  getRuntimeTaskChatScopeKey,
  normalizeGuidanceError,
} from './workbenchProviderHelpers'
import type { WorkbenchAction } from './workbenchReducer'
import {
  EMPTY_MESSAGE_TASK_TITLE,
  STANDALONE_PROJECT_ID,
  buildRuntimeTaskTitle,
  createConversationWorkspace,
  createRuntimeTaskId,
  createRuntimeTaskIdFromSeed,
  findProjectDeviceWorkspace,
  getCommandStdoutObject,
  isRecord,
  isSameRuntimeTaskIdentity,
  mergeRuntimeTaskHandles,
} from './workbenchRuntimeHelpers'
import type { WorkbenchRuntimeTasks } from './useWorkbenchRuntimeTasks'
import { applyRuntimeConversationAction } from './runtimeConversationCache'
import { findFileChangesBySubtaskId } from './runtimePaneMessages'
import { isRuntimeTaskBusyError } from './runtimePaneStatus'
import type { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle'
import {
  inferRuntimeName,
  resolveAutomaticModel,
  selectedModelExecutionFields,
} from './runtimeModelSelection'
import type { WorkbenchServices } from './workbenchServices'
import { track } from '@/telemetry/client'
import type { ExecutionTarget } from '@/telemetry/events'

function telemetryExecutionTarget(
  deviceId: string,
  devices: WorkbenchState['devices']
): ExecutionTarget {
  const device = devices.find(item => item.device_id === deviceId)
  if (device?.device_type === 'local' || device?.device_type === 'app') return 'local'
  if (device?.device_type === 'cloud' || device?.device_type === 'remote') return 'cloud'
  return deviceId === 'local-device' ? 'local' : 'unknown'
}

interface RuntimeAttachmentTransport {
  attachmentIds: number[]
  attachments: Attachment[]
}

function remoteRuntimeAttachment(attachment: Attachment): Attachment {
  const sanitized = { ...attachment }
  delete sanitized.local_path
  delete sanitized.local_preview_url
  return sanitized
}

export async function prepareRuntimeAttachmentsForDevice(
  deviceId: string,
  devices: WorkbenchState['devices'],
  attachmentIds: number[] = [],
  attachments: Attachment[] = [],
  uploadLocalAttachmentToCloud?: (attachment: Attachment) => Promise<Attachment>
): Promise<RuntimeAttachmentTransport> {
  const device = devices.find(item => item.device_id === deviceId)
  const usesRemoteFilesystem = device?.device_type === 'cloud' || device?.device_type === 'remote'
  if (!usesRemoteFilesystem || attachments.length === 0) {
    return { attachmentIds, attachments }
  }

  const existingRemoteIds = attachments
    .filter(attachment => attachment.id > 0)
    .map(attachment => attachment.id)
  const localAttachments = attachments.filter(attachment => attachment.id <= 0)
  if (localAttachments.some(attachment => !attachment.local_path?.trim())) {
    throw new Error(i18n.t('workbench.cloud_attachment_local_file_unavailable'))
  }
  if (localAttachments.length > 0 && !uploadLocalAttachmentToCloud) {
    throw new Error(i18n.t('workbench.cloud_attachment_upload_unavailable'))
  }

  const uploadedAttachments = await Promise.all(
    localAttachments.map(attachment => uploadLocalAttachmentToCloud!(attachment))
  )
  if (uploadedAttachments.some(attachment => attachment.id <= 0)) {
    throw new Error(i18n.t('workbench.cloud_attachment_upload_failed'))
  }

  return {
    attachmentIds: Array.from(
      new Set([
        ...attachmentIds,
        ...existingRemoteIds,
        ...uploadedAttachments.map(attachment => attachment.id),
      ])
    ),
    attachments: [
      ...attachments.filter(attachment => attachment.id > 0),
      ...uploadedAttachments,
    ].map(remoteRuntimeAttachment),
  }
}

interface RuntimeMessagingAttachmentSelection {
  attachments: Attachment[]
  resetAttachments: () => void
}

interface RuntimeMessagingModelSelection {
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  selectedModelOptions: ModelOptions
  getSelectedModel?: () => UnifiedModel | null
  getSelectedModelOptions?: () => ModelOptions
  setSelectionForScope?: (
    scopeKey: string,
    model: UnifiedModel | null,
    options?: ModelOptions
  ) => void
}

interface RuntimeMessagingSkillSelection {
  selectedSkills: SkillRef[]
}

interface UseWorkbenchRuntimeMessagingOptions {
  state: WorkbenchState
  dispatch: Dispatch<WorkbenchAction>
  executorClient: ExecutorClient
  services: WorkbenchServices
  runtimeTasks: WorkbenchRuntimeTasks
  lifecycleStore: RuntimeTaskLifecycleStore
  projectExecutionMode: string
  projectWorktreeBranch: string | null
  isOptionsLocked: boolean
  attachmentSelection: RuntimeMessagingAttachmentSelection
  modelSelection: RuntimeMessagingModelSelection
  skillSelection: RuntimeMessagingSkillSelection
  refreshWorkLists: () => Promise<void>
  rememberExecutionDevice: (deviceId: string) => void
}

function runtimeSendError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback
  return isRuntimeTaskBusyError(message)
    ? i18n.t('workbench.runtime_task_running_message')
    : message
}

export function runtimeThreadId(address?: RuntimeTaskAddress | null): string | null {
  if (typeof address?.threadId === 'string' && address.threadId.trim()) {
    return address.threadId
  }
  const handle = address?.runtimeHandle
  if (!isRecord(handle)) return null
  const threadId = handle.sessionId ?? handle.session_id ?? handle.threadId ?? handle.thread_id
  return typeof threadId === 'string' && threadId.trim() ? threadId : null
}

export function friendlyTitleForTask(
  preferences:
    | Pick<AppPreferences, 'friendlyTaskTitlesEnabled' | 'friendlyTaskTitleModel'>
    | undefined,
  models: UnifiedModel[],
  executionModel: Pick<RuntimeSendRequest, 'modelId' | 'modelType' | 'modelOptions'>,
  ephemeral?: boolean
): RuntimeTaskFriendlyTitleConfig | null {
  if (ephemeral || preferences?.friendlyTaskTitlesEnabled !== true) return null

  const configuredModel = preferences.friendlyTaskTitleModel
  const configuredModelIsAvailable =
    configuredModel &&
    models.some(
      model => model.name === configuredModel.modelName && model.type === configuredModel.modelType
    )
  if (configuredModel) {
    if (!configuredModelIsAvailable) return null
    return {
      modelId: configuredModel.executionModelId,
      modelType: configuredModel.executionModelType,
      modelOptions: configuredModel.options,
    }
  }

  return executionModel.modelId
    ? {
        modelId: executionModel.modelId,
        modelType: executionModel.modelType,
        modelOptions: executionModel.modelOptions,
      }
    : null
}

export function useWorkbenchRuntimeMessaging({
  state,
  dispatch,
  executorClient,
  services,
  runtimeTasks,
  lifecycleStore,
  projectExecutionMode,
  projectWorktreeBranch,
  isOptionsLocked,
  attachmentSelection,
  modelSelection,
  skillSelection,
  refreshWorkLists,
  rememberExecutionDevice,
}: UseWorkbenchRuntimeMessagingOptions) {
  const appPreferences = useAppPreferencesState()
  const preferences = appPreferences?.preferences
  const reportError = useCallback(
    (error: string, options?: RuntimePaneActionOptions) => {
      if (options?.onError) {
        options.onError(error)
        return
      }
      dispatch({ type: 'error_set', error })
    },
    [dispatch]
  )

  const reportSendBlocked = useCallback(
    (error: string, details?: Record<string, unknown>, options?: RuntimePaneActionOptions) => {
      console.warn('[Wework] send blocked:', error, details ?? {})
      reportError(error, options)
    },
    [reportError]
  )

  const prepareRuntimeSendRequest = useCallback(
    async (request: RuntimeSendRequest): Promise<RuntimeSendRequest> => {
      if (!request.attachments?.length) return request
      const prepared = await prepareRuntimeAttachmentsForDevice(
        request.address.deviceId,
        state.devices,
        request.attachmentIds,
        request.attachments,
        services.attachmentApi?.uploadLocalAttachmentToCloud
      )
      return {
        ...request,
        attachmentIds: prepared.attachmentIds,
        attachments: prepared.attachments,
      }
    },
    [services.attachmentApi, state.devices]
  )

  const sendRuntimePaneMessage = useCallback(
    async (request: RuntimeSendRequest, options?: RuntimePaneActionOptions): Promise<boolean> => {
      let sendRequested = false
      try {
        const outboundRequest = await prepareRuntimeSendRequest(request)
        const prepared = await executorClient.runtime.prepareRuntimeModel({
          deviceId: outboundRequest.address.deviceId,
          modelId: outboundRequest.modelId,
        })
        if (!prepared) {
          reportError(i18n.t('workbench.cloud_model_catalog_sync_cancelled'), options)
          return false
        }
        lifecycleStore.sendRequested(outboundRequest.address)
        sendRequested = true
        const response = await executorClient.runtime.sendRuntimeMessage(outboundRequest)
        if (!response.accepted) {
          throw new Error(response.error || '发送失败')
        }
        lifecycleStore.sendAccepted(outboundRequest.address)
        try {
          await refreshWorkLists()
        } catch (error) {
          console.warn('[Wework] Runtime send accepted but work list refresh failed', {
            taskId: response.taskId ?? outboundRequest.address.taskId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        return true
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '发送失败'
        const blockedByActiveTurn = isRuntimeTaskBusyError(errorMessage)
        if (sendRequested) {
          if (blockedByActiveTurn) {
            lifecycleStore.sendBlockedByActiveTurn(request.address)
          } else {
            lifecycleStore.sendRejected(request.address)
          }
        }
        if (blockedByActiveTurn) {
          try {
            await refreshWorkLists()
          } catch (refreshError) {
            console.warn('[Wework] Runtime busy-state refresh failed', {
              taskId: request.address.taskId,
              error: refreshError instanceof Error ? refreshError.message : String(refreshError),
            })
          }
        }
        console.warn('[Wework] Runtime send failed', {
          taskId: request.address.taskId,
          deviceId: request.address.deviceId,
          workspacePath: request.address.workspacePath ?? null,
          addressKeys: Object.keys(request.address as unknown as Record<string, unknown>).sort(),
          error: errorMessage,
        })
        reportError(runtimeSendError(error, '发送失败'), options)
        return false
      }
    },
    [executorClient, lifecycleStore, prepareRuntimeSendRequest, refreshWorkLists, reportError]
  )

  const interruptAndSendRuntimePaneMessage = useCallback(
    async (request: RuntimeSendRequest, options?: RuntimePaneActionOptions): Promise<boolean> => {
      let sendRequested = false
      try {
        const outboundRequest = await prepareRuntimeSendRequest(request)
        const prepared = await executorClient.runtime.prepareRuntimeModel({
          deviceId: outboundRequest.address.deviceId,
          modelId: outboundRequest.modelId,
        })
        if (!prepared) {
          reportError(i18n.t('workbench.cloud_model_catalog_sync_cancelled'), options)
          return false
        }
        lifecycleStore.sendRequested(outboundRequest.address)
        sendRequested = true
        const response =
          await executorClient.runtime.interruptAndSendRuntimeMessage(outboundRequest)
        if (!response.accepted) throw new Error(response.error || '打断并发送失败')
        lifecycleStore.sendAccepted(outboundRequest.address)
        void refreshWorkLists().catch(error => {
          console.warn('[Wework] Interrupt-and-send accepted but work list refresh failed', {
            taskId: response.taskId ?? outboundRequest.address.taskId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
        return true
      } catch (error) {
        if (sendRequested) lifecycleStore.sendRejected(request.address)
        reportError(runtimeSendError(error, '打断并发送失败'), options)
        return false
      }
    },
    [executorClient, lifecycleStore, prepareRuntimeSendRequest, refreshWorkLists, reportError]
  )

  const editLastUserMessage = useCallback(
    async (request: RuntimeRollbackRequest): Promise<boolean> => {
      let sendRequested = false
      try {
        const outboundRequest = await prepareRuntimeSendRequest(request)
        const prepared = await executorClient.runtime.prepareRuntimeModel({
          deviceId: outboundRequest.address.deviceId,
          modelId: outboundRequest.modelId,
        })
        if (!prepared) return false
        lifecycleStore.sendRequested(outboundRequest.address)
        sendRequested = true
        const response = await executorClient.runtime.rollbackRuntimeTask(outboundRequest)
        if (!response.accepted) {
          throw new Error(response.error || '编辑失败')
        }
        lifecycleStore.sendAccepted(outboundRequest.address)
        try {
          await refreshWorkLists()
        } catch (error) {
          console.warn('[Wework] Runtime rollback accepted but work list refresh failed', {
            taskId: response.taskId ?? outboundRequest.address.taskId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        return true
      } catch (error) {
        if (sendRequested) lifecycleStore.sendRejected(request.address)
        console.warn('[Wework] Runtime rollback for last user message failed', {
          taskId: request.address.taskId,
          deviceId: request.address.deviceId,
          workspacePath: request.address.workspacePath ?? null,
          addressKeys: Object.keys(request.address as unknown as Record<string, unknown>).sort(),
          error: error instanceof Error ? error.message : String(error),
        })
        dispatch({
          type: 'error_set',
          error: error instanceof Error ? error.message : '编辑失败',
        })
        return false
      }
    },
    [dispatch, executorClient, lifecycleStore, prepareRuntimeSendRequest, refreshWorkLists]
  )

  const sendRuntimePaneGuidance = useCallback(
    async (request: RuntimeGuidanceRequest): Promise<RuntimePaneGuidanceResult> => {
      try {
        let outboundRequest = request
        if (request.attachments?.length) {
          const preparedAttachments = await prepareRuntimeAttachmentsForDevice(
            request.address.deviceId,
            state.devices,
            request.attachmentIds,
            request.attachments,
            services.attachmentApi?.uploadLocalAttachmentToCloud
          )
          outboundRequest = {
            ...request,
            attachmentIds: preparedAttachments.attachmentIds,
            attachments: preparedAttachments.attachments,
          }
        }
        const response = await executorClient.runtime.guideRuntimeTask(outboundRequest)
        if (response.accepted === false || response.success === false) {
          console.warn('[Wework] Runtime guidance rejected', {
            taskId: response.taskId ?? response.task_id ?? request.address.taskId,
            deviceId: request.address.deviceId,
            code: response.code ?? null,
            error: response.error ?? null,
          })
          return {
            sent: false,
            code: response.code,
            error: response.error || '引导发送失败',
          }
        }
        console.info('[Wework] Runtime guidance accepted', {
          taskId: response.taskId ?? response.task_id ?? request.address.taskId,
          deviceId: request.address.deviceId,
          turnId: response.turnId ?? response.turn_id ?? null,
        })
        void refreshWorkLists().catch(error => {
          console.warn('[Wework] Runtime guidance accepted but work list refresh failed', {
            taskId: response.taskId ?? response.task_id ?? request.address.taskId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
        return {
          sent: true,
          turnId: response.turnId ?? response.turn_id,
          code: response.code,
          error: response.error,
        }
      } catch (error) {
        console.warn('[Wework] Runtime guidance failed', {
          taskId: request.address.taskId,
          deviceId: request.address.deviceId,
          workspacePath: request.address.workspacePath ?? null,
          error: error instanceof Error ? error.message : String(error),
        })
        reportError(normalizeGuidanceError(error instanceof Error ? error.message : '引导发送失败'))
        return {
          sent: false,
          error: error instanceof Error ? error.message : '引导发送失败',
        }
      }
    },
    [executorClient, refreshWorkLists, reportError, services.attachmentApi, state.devices]
  )

  const compactRuntimePaneTask = useCallback(
    async (address: RuntimeTaskAddress, options?: RuntimePaneActionOptions): Promise<boolean> => {
      lifecycleStore.sendRequested(address)
      try {
        const response = await executorClient.runtime.compactRuntimeTask({ address })
        if (!response.accepted) {
          throw new Error(response.error || '压缩上下文失败')
        }
        lifecycleStore.sendAccepted(address)
        try {
          await refreshWorkLists()
        } catch (error) {
          console.warn('[Wework] Runtime compact accepted but work list refresh failed', {
            taskId: response.taskId ?? address.taskId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        lifecycleStore.executorSettled(address)
        return true
      } catch (error) {
        lifecycleStore.sendRejected(address)
        console.warn('[Wework] Runtime compact failed', {
          taskId: address.taskId,
          deviceId: address.deviceId,
          workspacePath: address.workspacePath ?? null,
          error: error instanceof Error ? error.message : String(error),
        })
        reportError(error instanceof Error ? error.message : '压缩上下文失败', options)
        return false
      }
    },
    [executorClient, lifecycleStore, refreshWorkLists, reportError]
  )

  const cancelRuntimePaneTask = useCallback(
    async (address: RuntimeTaskAddress, options?: RuntimePaneActionOptions): Promise<boolean> => {
      lifecycleStore.stopRequested(address)
      try {
        const ack = await executorClient.runtime.cancelRuntimeTask(address)
        if (!ack.accepted) {
          lifecycleStore.stopRejected(address)
          reportError(normalizeGuidanceError(ack.error ?? '取消当前回复失败'), options)
          return false
        }
        await refreshWorkLists()
        return true
      } catch (error) {
        lifecycleStore.stopRejected(address)
        reportError(
          normalizeGuidanceError(error instanceof Error ? error.message : '取消当前回复失败'),
          options
        )
        return false
      }
    },
    [executorClient, lifecycleStore, refreshWorkLists, reportError]
  )

  const buildSendPayload = useCallback(
    (
      message: string,
      sourceAttachments?: Attachment[],
      projectOverride?: ProjectWithTasks | null,
      includeSelectedSkills = !isOptionsLocked,
      selectedSkillsOverride?: SkillRef[],
      deviceOverride?: string | null
    ): { payload: ChatSendPayload; activeDeviceId?: string } | null => {
      if (!state.defaultTeam) return null
      const activeProject = projectOverride === undefined ? state.currentProject : projectOverride
      const selectedProjectWorkspace = findProjectDeviceWorkspace(
        state.runtimeWork,
        activeProject?.id,
        state.selectedDeviceWorkspaceId
      )
      const activeDeviceId =
        deviceOverride ||
        (activeProject && selectedProjectWorkspace
          ? selectedProjectWorkspace.deviceId
          : getActiveWorkbenchDeviceId({
              currentProject: activeProject,
              standaloneDeviceId: getPreferredStandaloneDeviceId(
                state.devices,
                state.standaloneDeviceId
              ),
            }))

      const payload: ChatSendPayload = {
        team_id: state.defaultTeam.id,
        project_id: activeProject?.id ?? STANDALONE_PROJECT_ID,
        client_origin: WEWORK_CLIENT_ORIGIN,
        device_id: activeDeviceId,
        task_type: 'code',
        message,
      }
      const selectedModel =
        modelSelection.getSelectedModel?.() ??
        modelSelection.selectedModel ??
        resolveAutomaticModel(modelSelection.models)
      const selectedModelOptions =
        modelSelection.getSelectedModelOptions?.() ?? modelSelection.selectedModelOptions

      if (
        activeProject &&
        projectExecutionMode === 'git_worktree' &&
        supportsGitWorktreeExecution(activeProject)
      ) {
        const branch = projectWorktreeBranch?.trim()
        payload.execution = {
          workspace: {
            source: 'git_worktree',
            ...(branch ? { branch } : {}),
          },
        }
      }

      const executionModel = selectedModelExecutionFields(selectedModel, selectedModelOptions)
      debugRuntimeCreateFlow('model-options-resolved', {
        selectedModel: selectedModel?.name ?? null,
        selectedModelType: selectedModel?.type ?? null,
        selectedModelOptions: summarizeModelOptions(selectedModelOptions),
        executionModelOptions: summarizeModelOptions(executionModel.modelOptions),
      })
      if (selectedModel) {
        payload.force_override_bot_model = executionModel.modelId
        if (executionModel.modelType) {
          payload.force_override_bot_model_type = executionModel.modelType
        }
      }
      if (executionModel.modelOptions && Object.keys(executionModel.modelOptions).length > 0) {
        payload.model_options = executionModel.modelOptions
      }

      const selectedSkills = selectedSkillsOverride ?? skillSelection.selectedSkills
      if (
        (selectedSkillsOverride !== undefined || includeSelectedSkills) &&
        selectedSkills.length > 0
      ) {
        payload.additional_skills = selectedSkills
      }

      const payloadAttachments = sourceAttachments ?? attachmentSelection.attachments
      if (payloadAttachments.length > 0) {
        const attachmentIds = remoteAttachmentIds(payloadAttachments)
        const localAttachments = localRuntimeAttachments(payloadAttachments)
        if (attachmentIds.length > 0) {
          payload.attachment_ids = attachmentIds
        }
        if (localAttachments.length > 0) {
          payload.attachments = localAttachments
        }
        if (!message) {
          payload.title = EMPTY_MESSAGE_TASK_TITLE
        }
      }

      return { payload, activeDeviceId }
    },
    [
      attachmentSelection.attachments,
      isOptionsLocked,
      modelSelection,
      projectExecutionMode,
      projectWorktreeBranch,
      skillSelection.selectedSkills,
      state.currentProject,
      state.defaultTeam,
      state.devices,
      state.runtimeWork,
      state.selectedDeviceWorkspaceId,
      state.standaloneDeviceId,
    ]
  )

  const sendPreparedRuntimeMessage = useCallback(
    async (
      displayMessage: string,
      payload: ChatSendPayload,
      activeDeviceId?: string,
      options?: Pick<
        SendCurrentInputOptions,
        | 'clientUserMessageId'
        | 'initialGoal'
        | 'initialSupervisor'
        | 'onError'
        | 'onRuntimeTaskOptimisticOpen'
        | 'additionalContext'
      > & {
        collaborationMode?: 'default' | 'plan'
        deliveryId?: string
        cloudProjectId?: string
        ephemeral?: boolean
        continuable?: boolean
        openInMainPane?: boolean
        refreshWorkListsOnResolve?: boolean
        sideSource?: RuntimeTaskAddress | null
        modelSelection?: {
          modelName: string
          modelType: ModelType | null
          options: ModelOptions
        } | null
        preserveAttachments?: boolean
        launchStartedAt?: number
      }
    ): Promise<RuntimeTaskAddress | false> => {
      const launchStartedAt = options?.launchStartedAt ?? runtimeLaunchNowMs()
      const projectId = payload.project_id && payload.project_id > 0 ? payload.project_id : null
      const overrideSelection = options?.modelSelection
      const selectedModel = overrideSelection
        ? (modelSelection.models.find(
            model =>
              model.name === overrideSelection.modelName &&
              (!overrideSelection.modelType || model.type === overrideSelection.modelType)
          ) ?? null)
        : (modelSelection.getSelectedModel?.() ??
          modelSelection.selectedModel ??
          resolveAutomaticModel(modelSelection.models))
      const selectedModelOptions = overrideSelection
        ? (overrideSelection.options ?? {})
        : (modelSelection.getSelectedModelOptions?.() ?? modelSelection.selectedModelOptions)
      const executionModel = selectedModelExecutionFields(selectedModel, selectedModelOptions)
      const friendlyTitle = friendlyTitleForTask(
        preferences,
        modelSelection.models,
        executionModel,
        options?.ephemeral
      )
      const runtime = inferRuntimeName(selectedModel)
      const taskSeed = createRuntimeTaskId(runtime)
      const taskId = createRuntimeTaskIdFromSeed(taskSeed)
      logRuntimeTaskLaunchTiming('prepared-send-entered', launchStartedAt, {
        taskId,
        clientUserMessageId: options?.clientUserMessageId ?? null,
        projectId,
        runtime,
      })
      const selectedProjectWorkspace = findProjectDeviceWorkspace(
        state.runtimeWork,
        projectId,
        state.selectedDeviceWorkspaceId
      )
      const selectedRuntimeProject = projectId
        ? state.runtimeWork?.projects.find(item => runtimeProjectUiId(item.project) === projectId)
            ?.project
        : null
      const selectedRuntimeProjectWork = projectId
        ? state.runtimeWork?.projects.find(item => runtimeProjectUiId(item.project) === projectId)
        : null
      const configuredRuntimeRoots =
        selectedRuntimeProject?.roots?.map(root => root.path.trim()).filter(Boolean) ?? []
      const runtimeWorkspaceRoots =
        selectedRuntimeProject?.source === 'local_project'
          ? Array.from(
              new Set(
                (configuredRuntimeRoots.length > 0
                  ? configuredRuntimeRoots
                  : (selectedRuntimeProjectWork?.deviceWorkspaces.map(
                      workspace => workspace.workspacePath
                    ) ?? [])
                )
                  .map(normalizeRuntimeWorkspacePath)
                  .filter(Boolean)
              )
            )
          : []
      let runtimeTaskTarget: Pick<
        RuntimeTaskCreateRequest,
        'projectId' | 'deviceWorkspaceId' | 'deviceId' | 'workspacePath'
      >
      let optimisticDeviceId: string
      if (options?.sideSource?.deviceId && options.sideSource.workspacePath) {
        optimisticDeviceId = options.sideSource.deviceId
        runtimeTaskTarget = {
          deviceId: options.sideSource.deviceId,
          workspacePath: options.sideSource.workspacePath,
        }
      } else if (projectId) {
        if (!selectedProjectWorkspace) {
          reportSendBlocked('请选择任务运行位置', undefined, options)
          return false
        }
        optimisticDeviceId = selectedProjectWorkspace.deviceId
        runtimeTaskTarget =
          selectedProjectWorkspace.id != null &&
          selectedProjectWorkspace.workspaceSource !== 'local' &&
          !services.cloudBackgroundApi
            ? {
                projectId,
                deviceWorkspaceId: selectedProjectWorkspace.id,
                deviceId: selectedProjectWorkspace.deviceId,
                workspacePath: selectedProjectWorkspace.workspacePath,
              }
            : {
                deviceId: selectedProjectWorkspace.deviceId,
                workspacePath: selectedProjectWorkspace.workspacePath,
              }
      } else {
        let workspacePath = state.standaloneWorkspacePath
        if (!workspacePath && activeDeviceId) {
          try {
            logRuntimeTaskLaunchTiming('standalone-workspace-started', launchStartedAt, {
              taskId,
              clientUserMessageId: options?.clientUserMessageId ?? null,
              deviceId: activeDeviceId,
            })
            workspacePath = await createConversationWorkspace(
              executorClient.commands,
              activeDeviceId,
              displayMessage,
              taskId
            )
            logRuntimeTaskLaunchTiming('standalone-workspace-resolved', launchStartedAt, {
              taskId,
              clientUserMessageId: options?.clientUserMessageId ?? null,
              deviceId: activeDeviceId,
            })
          } catch (error) {
            logRuntimeTaskLaunchTiming('standalone-workspace-failed', launchStartedAt, {
              taskId,
              clientUserMessageId: options?.clientUserMessageId ?? null,
              deviceId: activeDeviceId,
              error: runtimeLaunchErrorName(error),
            })
            reportSendBlocked(
              error instanceof Error ? error.message : '创建对话工作区失败',
              undefined,
              options
            )
            return false
          }
        }
        if (!activeDeviceId || !workspacePath) {
          reportSendBlocked('请选择项目或打开设备工作区后再发送', undefined, options)
          return false
        }
        optimisticDeviceId = activeDeviceId
        runtimeTaskTarget = {
          deviceId: activeDeviceId,
          workspacePath,
        }
      }

      let preparedAttachments: RuntimeAttachmentTransport
      try {
        preparedAttachments = await prepareRuntimeAttachmentsForDevice(
          optimisticDeviceId,
          state.devices,
          payload.attachment_ids,
          payload.attachments,
          services.attachmentApi?.uploadLocalAttachmentToCloud
        )
      } catch (error) {
        reportSendBlocked(
          error instanceof Error
            ? error.message
            : i18n.t('workbench.cloud_attachment_upload_failed'),
          undefined,
          options
        )
        return false
      }

      const createRequest: RuntimeTaskCreateRequest = {
        ...runtimeTaskTarget,
        taskId,
        teamId: payload.team_id,
        runtime,
        message: payload.message,
        ...(options?.clientUserMessageId
          ? { clientUserMessageId: options.clientUserMessageId }
          : {}),
        title: buildRuntimeTaskTitle(displayMessage, payload.title),
        modelId: payload.force_override_bot_model,
        modelType: payload.force_override_bot_model_type ?? null,
        modelOptions: {
          ...(payload.model_options ?? {}),
          ...(options && 'collaborationMode' in options && options.collaborationMode
            ? { collaborationMode: options.collaborationMode }
            : {}),
        },
        modelSelection:
          options?.modelSelection ??
          (selectedModel
            ? {
                modelName: selectedModel.name,
                modelType: selectedModel.type,
                options: selectedModelOptions,
              }
            : null),
        ...(friendlyTitle ? { friendlyTitle } : {}),
        additionalSkills: payload.additional_skills ?? [],
        attachmentIds: preparedAttachments.attachmentIds,
        attachments: preparedAttachments.attachments,
        execution: payload.execution,
        ...(selectedRuntimeProject?.source === 'local_project'
          ? {
              runtimeProjectKey: selectedRuntimeProject.key,
              runtimeProjectName: selectedRuntimeProject.name,
              runtimeWorkspaceRoots,
            }
          : {}),
        ...(options?.ephemeral ? { ephemeral: true } : {}),
        ...(options?.continuable ? { continuable: true } : {}),
        ...(options?.sideSource ? { sideSource: options.sideSource } : {}),
        ...(options?.initialGoal ? { initialGoal: options.initialGoal } : {}),
        ...(options?.initialSupervisor ? { initialSupervisor: options.initialSupervisor } : {}),
        ...(options?.deliveryId ? { deliveryId: options.deliveryId } : {}),
        ...(options?.cloudProjectId ? { cloudProjectId: options.cloudProjectId } : {}),
        ...(options?.additionalContext ? { additionalContext: options.additionalContext } : {}),
      }
      debugRuntimeCreateFlow('create-request-built', {
        taskId,
        runtime,
        modelId: createRequest.modelId ?? null,
        modelType: createRequest.modelType ?? null,
        modelOptions: summarizeModelOptions(createRequest.modelOptions),
      })
      const createModelSelection = modelSelectionFromCreateRequest(createRequest)
      const createRuntimeHandle = createModelSelection
        ? { modelSelection: createModelSelection }
        : undefined
      const optimisticAddress: RuntimeTaskAddress = {
        deviceId: optimisticDeviceId,
        taskId,
        workspacePath:
          'workspacePath' in runtimeTaskTarget ? runtimeTaskTarget.workspacePath : undefined,
        ...(createRuntimeHandle ? { runtimeHandle: createRuntimeHandle } : {}),
      }
      modelSelection.setSelectionForScope?.(
        getRuntimeTaskChatScopeKey(optimisticAddress),
        selectedModel,
        selectedModelOptions
      )
      const optimisticWorkspacePath =
        ('workspacePath' in runtimeTaskTarget ? runtimeTaskTarget.workspacePath : undefined) ??
        selectedProjectWorkspace?.workspacePath
      const optimisticWorkspace =
        optimisticWorkspacePath && optimisticDeviceId
          ? buildOptimisticRuntimeWorkspace({
              baseWorkspace: selectedProjectWorkspace,
              devices: state.devices,
              deviceId: optimisticDeviceId,
              workspacePath: optimisticWorkspacePath,
              projectId,
              workspaceKind:
                payload.execution?.workspace?.source === 'git_worktree' ? 'worktree' : undefined,
            })
          : null
      const runtimeProject = projectId
        ? (state.projects.find(project => project.id === projectId) ?? state.currentProject)
        : null

      if (optimisticAddress.deviceId) rememberExecutionDevice(optimisticAddress.deviceId)
      debugRuntimeCreateFlow('create-optimistic-open', {
        taskId,
        runtime,
        projectId,
        optimisticAddress: runtimeAddressLog(optimisticAddress),
        hasSelectedProjectWorkspace: Boolean(selectedProjectWorkspace),
        optimisticWorkspacePath: optimisticWorkspacePath ?? null,
      })
      lifecycleStore.sendRequested(optimisticAddress)
      if (options?.initialGoal) {
        lifecycleStore.goalStatusReceived(optimisticAddress, options.initialGoal.status ?? 'active')
      }
      logRuntimeTaskLaunchTiming('optimistic-open-started', launchStartedAt, {
        taskId,
        clientUserMessageId: options?.clientUserMessageId ?? null,
        deviceId: optimisticAddress.deviceId,
      })
      await options?.onRuntimeTaskOptimisticOpen?.(optimisticAddress)
      if (options?.openInMainPane !== false) {
        runtimeTasks.openRuntimeTaskView(optimisticAddress, runtimeProject, { navigate: true })
      }
      logRuntimeTaskLaunchTiming('optimistic-open-dispatched', launchStartedAt, {
        taskId,
        clientUserMessageId: options?.clientUserMessageId ?? null,
        deviceId: optimisticAddress.deviceId,
        openedInMainPane: options?.openInMainPane !== false,
      })
      logRuntimeTaskLaunchPaintTiming(launchStartedAt, {
        taskId,
        clientUserMessageId: options?.clientUserMessageId ?? null,
        deviceId: optimisticAddress.deviceId,
      })
      if (optimisticWorkspace && optimisticWorkspacePath && !options?.ephemeral) {
        dispatch({
          type: 'runtime_task_optimistic_upserted',
          project: runtimeProject,
          workspace: optimisticWorkspace,
          task: buildOptimisticRuntimeTask({
            taskId: optimisticAddress.taskId,
            workspacePath: optimisticWorkspacePath,
            title: createRequest.title ?? buildRuntimeTaskTitle(displayMessage, payload.title),
            runtime,
            workspaceKind:
              payload.execution?.workspace?.source === 'git_worktree' ? 'worktree' : undefined,
            modelSelection: createModelSelection,
          }),
        })
      }
      if (!options?.preserveAttachments) {
        attachmentSelection.resetAttachments()
      }

      try {
        logRuntimeTaskLaunchTiming('runtime-create-started', launchStartedAt, {
          taskId,
          clientUserMessageId: options?.clientUserMessageId ?? null,
          deviceId: optimisticAddress.deviceId,
        })
        const worktreeCreationDelayMs = Number(
          import.meta.env.VITE_WEWORK_E2E_WORKTREE_CREATION_DELAY_MS ?? 0
        )
        if (
          payload.execution?.workspace?.source === 'git_worktree' &&
          Number.isFinite(worktreeCreationDelayMs) &&
          worktreeCreationDelayMs > 0
        ) {
          await new Promise(resolve => window.setTimeout(resolve, worktreeCreationDelayMs))
        }
        const response = await executorClient.runtime.createRuntimeTask(createRequest)
        logRuntimeTaskLaunchTiming('runtime-create-resolved', launchStartedAt, {
          taskId,
          clientUserMessageId: options?.clientUserMessageId ?? null,
          deviceId: response.deviceId || optimisticAddress.deviceId,
          accepted: response.accepted,
        })
        if (!response.accepted) {
          throw new Error(response.error || '发送失败')
        }
        const runtimeHandle = mergeRuntimeTaskHandles(
          response.runtimeHandle,
          optimisticAddress.runtimeHandle
        )
        const address: RuntimeTaskAddress = {
          deviceId: response.deviceId || optimisticAddress.deviceId,
          taskId: response.taskId || optimisticAddress.taskId,
          workspacePath: response.workspacePath || optimisticAddress.workspacePath,
          ...(runtimeHandle ? { runtimeHandle } : {}),
          ...(response.taskId || optimisticAddress.taskId
            ? { taskId: response.taskId || optimisticAddress.taskId }
            : {}),
        }
        debugRuntimeCreateFlow('create-resolved', {
          taskId: address.taskId,
          runtime,
          projectId,
          accepted: response.accepted,
          optimisticAddress: runtimeAddressLog(optimisticAddress),
          resolvedAddress: runtimeAddressLog(address),
          sameIdentity: isSameRuntimeTaskIdentity(optimisticAddress, address),
          responseHasWorkspacePath: Boolean(response.workspacePath),
          responseHasTaskId: Boolean(response.taskId),
        })
        const resolvedWorkspacePath = address.workspacePath ?? optimisticWorkspacePath
        const resolvedSameIdentity = isSameRuntimeTaskIdentity(optimisticAddress, address)
        const optimisticTaskStillSelected = runtimeTasks.isCurrentRuntimeTask(optimisticAddress)
        if (!resolvedSameIdentity) {
          dispatch({ type: 'runtime_task_optimistic_removed', address: optimisticAddress })
        }
        if (resolvedWorkspacePath && !options?.ephemeral) {
          dispatch({
            type: 'runtime_task_optimistic_upserted',
            project: runtimeProject,
            workspace: buildOptimisticRuntimeWorkspace({
              baseWorkspace: optimisticWorkspace,
              devices: state.devices,
              deviceId: address.deviceId,
              workspacePath: resolvedWorkspacePath,
              projectId,
              workspaceKind:
                payload.execution?.workspace?.source === 'git_worktree' ? 'worktree' : undefined,
            }),
            task: buildOptimisticRuntimeTask({
              taskId: address.taskId,
              workspacePath: resolvedWorkspacePath,
              title: createRequest.title ?? buildRuntimeTaskTitle(displayMessage, payload.title),
              runtime,
              status: response.status ?? 'running',
              queuePosition: response.queuePosition,
              workspaceKind:
                payload.execution?.workspace?.source === 'git_worktree' ? 'worktree' : undefined,
              modelSelection: createModelSelection,
            }),
          })
        }
        if (!resolvedSameIdentity) {
          lifecycleStore.rename(optimisticAddress, address)
          modelSelection.setSelectionForScope?.(
            getRuntimeTaskChatScopeKey(address),
            selectedModel,
            selectedModelOptions
          )
          if (address.deviceId) rememberExecutionDevice(address.deviceId)
          debugRuntimeCreateFlow('create-final-open', {
            taskId: address.taskId,
            runtime,
            previousAddress: runtimeAddressLog(optimisticAddress),
            finalAddress: runtimeAddressLog(address),
          })
          options?.onRuntimeTaskOptimisticOpen?.(address, {
            previousAddress: optimisticAddress,
          })
          if (options?.openInMainPane !== false && optimisticTaskStillSelected) {
            runtimeTasks.openRuntimeTaskView(address, runtimeProject, { navigate: true })
          }
        }
        lifecycleStore.sendAccepted(address)
        track('conversation_created', {
          execution_target: telemetryExecutionTarget(address.deviceId, state.devices),
        })
        if (!options?.ephemeral) {
          void notifyMainRuntimeWorkChanged({
            deviceId: address.deviceId,
            taskId: address.taskId,
          }).catch(error => {
            console.warn('[Wework] Failed to notify main window about runtime task creation', {
              deviceId: address.deviceId,
              taskId: address.taskId,
              error,
            })
          })
        }
        if (options?.refreshWorkListsOnResolve !== false) {
          await refreshWorkLists()
        }
        if (options?.openInMainPane !== false) {
          dispatch({ type: 'blank_chat_committed' })
        }
        return address
      } catch (error) {
        logRuntimeTaskLaunchTiming('runtime-create-failed', launchStartedAt, {
          taskId,
          clientUserMessageId: options?.clientUserMessageId ?? null,
          deviceId: optimisticAddress.deviceId,
          error: runtimeLaunchErrorName(error),
        })
        const message = error instanceof Error ? error.message : '发送失败'
        lifecycleStore.sendRejected(optimisticAddress)
        if (optimisticWorkspace && optimisticWorkspacePath && !options?.ephemeral) {
          dispatch({
            type: 'runtime_task_optimistic_upserted',
            project: runtimeProject,
            workspace: optimisticWorkspace,
            task: buildOptimisticRuntimeTask({
              taskId: optimisticAddress.taskId,
              workspacePath: optimisticWorkspacePath,
              title: createRequest.title ?? buildRuntimeTaskTitle(displayMessage, payload.title),
              runtime,
              status: 'failed',
              workspaceKind:
                payload.execution?.workspace?.source === 'git_worktree' ? 'worktree' : undefined,
              error: message,
            }),
          })
        } else {
          dispatch({ type: 'runtime_task_optimistic_removed', address: optimisticAddress })
          if (runtimeTasks.isCurrentRuntimeTask(optimisticAddress)) {
            runtimeTasks.clearCurrentRuntimeTaskView()
          }
        }
        reportError(message, options)
        return false
      }
    },
    [
      attachmentSelection,
      preferences,
      dispatch,
      executorClient,
      lifecycleStore,
      modelSelection,
      refreshWorkLists,
      rememberExecutionDevice,
      reportError,
      reportSendBlocked,
      runtimeTasks,
      services.attachmentApi,
      services.cloudBackgroundApi,
      state.currentProject,
      state.devices,
      state.projects,
      state.runtimeWork,
      state.selectedDeviceWorkspaceId,
      state.standaloneWorkspacePath,
    ]
  )

  const sendCurrentInput = useCallback(
    async (inputOverride?: string, options?: SendCurrentInputOptions) => {
      const launchStartedAt = runtimeLaunchNowMs()
      logRuntimeTaskLaunchTiming('send-current-entered', launchStartedAt, {
        clientUserMessageId: options?.clientUserMessageId ?? null,
        forceNewTask: options?.forceNewTask === true,
        hasCurrentRuntimeTask: Boolean(state.currentRuntimeTask),
      })
      const rawInput = inputOverride ?? ''
      const trimmedMessage = rawInput.trim()
      const effectiveCodeCommentContexts = options?.codeCommentContexts ?? []
      const hasAttachments = attachmentSelection.attachments.length > 0
      const hasCodeComments = effectiveCodeCommentContexts.length > 0
      if (!trimmedMessage && !hasAttachments && !hasCodeComments) {
        reportSendBlocked('请输入内容或添加附件后再发送', undefined, options)
        return false
      }
      const message =
        trimmedMessage || (hasCodeComments ? i18n.t('workbench.code_comment_fallback') : '')
      const payloadMessage = appendCodeCommentContexts(message, effectiveCodeCommentContexts)
      const runtimeSelectedModel =
        modelSelection.getSelectedModel?.() ??
        modelSelection.selectedModel ??
        resolveAutomaticModel(modelSelection.models)
      const runtimeSelectedModelOptions =
        modelSelection.getSelectedModelOptions?.() ?? modelSelection.selectedModelOptions
      const runtimeModelFields = selectedModelExecutionFields(
        runtimeSelectedModel,
        runtimeSelectedModelOptions
      )

      if (state.currentRuntimeTask && !options?.forceNewTask) {
        if (hasCodeComments) {
          reportSendBlocked('当前 LocalTask 暂不支持代码评论', undefined, options)
          return false
        }
        if (lifecycleStore.getTask(state.currentRuntimeTask)?.derived.isRunning) {
          reportSendBlocked(i18n.t('workbench.runtime_task_running_message'), undefined, options)
          return false
        }
        const currentAttachments = attachmentSelection.attachments
        const attachmentIds = remoteAttachmentIds(currentAttachments)
        const attachments = localRuntimeAttachments(currentAttachments)
        const sent = await sendRuntimePaneMessage(
          {
            address: state.currentRuntimeTask,
            message: payloadMessage,
            ...(options?.clientUserMessageId
              ? { clientUserMessageId: options.clientUserMessageId }
              : {}),
            ...runtimeModelFields,
            ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
            ...(options?.additionalContext ? { additionalContext: options.additionalContext } : {}),
          },
          options
        )
        if (sent) {
          attachmentSelection.resetAttachments()
        }
        return sent
      }

      const prepared = buildSendPayload(
        payloadMessage,
        undefined,
        undefined,
        options?.forceNewTask || !isOptionsLocked,
        options?.additionalSkills
      )
      if (!prepared) {
        reportSendBlocked(
          'Wework default team is not configured',
          {
            hasDefaultTeam: Boolean(state.defaultTeam),
          },
          options
        )
        return false
      }
      if (prepared.activeDeviceId) {
        const activeDevice = findWorkbenchDevice(state.devices, prepared.activeDeviceId)
        if (!isWorkbenchDeviceOnline(activeDevice)) {
          const deviceName =
            getWorkbenchDeviceUnavailableDisplayName(activeDevice) ||
            i18n.t('workbench.current_device')
          const status = activeDevice
            ? (DEVICE_STATUS_LABELS[activeDevice.status] ?? activeDevice.status)
            : '不可用'
          reportSendBlocked(
            `${deviceName} ${status}，恢复在线后可继续对话`,
            {
              activeDeviceId: prepared.activeDeviceId,
              deviceStatus: activeDevice?.status ?? null,
            },
            options
          )
          return false
        }
        if (activeDevice && isDeviceBelowWeWorkVersion(activeDevice)) {
          const deviceName = getWorkbenchDeviceDisplayName(activeDevice, prepared.activeDeviceId)
          reportSendBlocked(
            `${deviceName} 版本低于 ${WEWORK_MIN_EXECUTOR_VERSION}，升级后可继续对话`,
            {
              activeDeviceId: prepared.activeDeviceId,
              executorVersion: activeDevice.executor_version ?? null,
            },
            options
          )
          return false
        }
      } else if (!state.currentProject) {
        const hasOnlineCompatibleDevice = state.devices.some(
          device => device.status === 'online' && isWeWorkCompatibleDevice(device)
        )
        if (!hasOnlineCompatibleDevice) {
          reportSendBlocked(
            `暂无满足 ${WEWORK_MIN_EXECUTOR_VERSION} 的在线设备，请连接或升级设备`,
            {
              deviceCount: state.devices.length,
            },
            options
          )
          return false
        }
      }

      const sent = await sendPreparedRuntimeMessage(
        message,
        prepared.payload,
        prepared.activeDeviceId,
        {
          launchStartedAt,
          initialGoal: options?.initialGoal,
          initialSupervisor: options?.initialSupervisor,
          onError: options?.onError,
          onRuntimeTaskOptimisticOpen: options?.onRuntimeTaskOptimisticOpen,
          clientUserMessageId: options?.clientUserMessageId,
          additionalContext: options?.additionalContext,
          cloudProjectId: options?.cloudProjectId,
        }
      )
      if (sent) {
        attachmentSelection.resetAttachments()
      }
      return sent
    },
    [
      attachmentSelection,
      buildSendPayload,
      isOptionsLocked,
      lifecycleStore,
      modelSelection,
      reportSendBlocked,
      sendPreparedRuntimeMessage,
      sendRuntimePaneMessage,
      state.currentProject,
      state.currentRuntimeTask,
      state.defaultTeam,
      state.devices,
    ]
  )

  const retryFailedMessage = useCallback(
    async (
      messageId: string,
      messagesOverride?: WorkbenchMessage[],
      retryUserMessageOverride?: WorkbenchMessage
    ): Promise<boolean> => {
      const messageSource = messagesOverride ?? []
      const failedMessageIndex = messageSource.findIndex(
        message =>
          message.id === messageId && message.role === 'assistant' && message.status === 'failed'
      )
      if (failedMessageIndex === -1) {
        dispatch({ type: 'error_set', error: '未找到可重试的失败消息' })
        return false
      }
      const failedMessage = messageSource[failedMessageIndex]

      const previousUserMessage =
        retryUserMessageOverride?.role === 'user'
          ? retryUserMessageOverride
          : [...messageSource]
              .slice(0, failedMessageIndex)
              .reverse()
              .find(message => message.role === 'user')
      if (!previousUserMessage) {
        dispatch({ type: 'error_set', error: '未找到可重试的用户消息' })
        return false
      }

      if (state.currentRuntimeTask) {
        const runtimeSelectedModel =
          modelSelection.getSelectedModel?.() ??
          modelSelection.selectedModel ??
          resolveAutomaticModel(modelSelection.models)
        const runtimeSelectedModelOptions =
          modelSelection.getSelectedModelOptions?.() ?? modelSelection.selectedModelOptions
        const previousAttachments = previousUserMessage.attachments ?? []
        const attachmentIds = remoteAttachmentIds(previousAttachments)
        const attachments = localRuntimeAttachments(previousAttachments)
        return sendRuntimePaneMessage({
          address: state.currentRuntimeTask,
          message: previousUserMessage.content,
          clientUserMessageId: previousUserMessage.id,
          retrySourceTurnId: failedMessage.turnId ?? failedMessage.subtaskId,
          ...selectedModelExecutionFields(runtimeSelectedModel, runtimeSelectedModelOptions),
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        })
      }

      reportSendBlocked('当前没有可重试的 LocalTask')
      return false
    },
    [dispatch, modelSelection, reportSendBlocked, sendRuntimePaneMessage, state.currentRuntimeTask]
  )

  const createEphemeralRuntimeTask = useCallback(
    async (
      input: string,
      options?: CreateTemporaryRuntimeTaskOptions
    ): Promise<RuntimeTaskAddress | false> => {
      const message = input.trim()
      if (!message) {
        reportSendBlocked('请输入内容后再发送', undefined, options)
        return false
      }
      const prepared = buildSendPayload(message, options?.attachments, options?.project)
      if (!prepared) {
        reportSendBlocked(
          'Wework default team is not configured',
          { hasDefaultTeam: Boolean(state.defaultTeam) },
          options
        )
        return false
      }

      return sendPreparedRuntimeMessage(message, prepared.payload, prepared.activeDeviceId, {
        onError: options?.onError,
        onRuntimeTaskOptimisticOpen: options?.onRuntimeTaskOptimisticOpen,
        ephemeral: true,
        sideSource: options?.source && runtimeThreadId(options.source) ? options.source : null,
        openInMainPane: false,
        refreshWorkListsOnResolve: false,
        preserveAttachments: true,
      })
    },
    [buildSendPayload, reportSendBlocked, sendPreparedRuntimeMessage, state.defaultTeam]
  )

  const createTemporaryRuntimeTask = useCallback(
    async (
      input: string,
      options?: CreateTemporaryRuntimeTaskOptions
    ): Promise<RuntimeTaskAddress | false> => {
      if (!options?.source || !runtimeThreadId(options.source)) {
        reportSendBlocked('请先打开一个已有对话后再开始临时聊天', undefined, options)
        return false
      }
      return createEphemeralRuntimeTask(input, options)
    },
    [createEphemeralRuntimeTask, reportSendBlocked]
  )

  const createProjectRuntimeTask = useCallback(
    async (
      input: string,
      options: CreateProjectRuntimeTaskOptions
    ): Promise<RuntimeTaskAddress | false> => {
      const message = input.trim()
      if (!message) {
        reportSendBlocked('请输入内容后再发送', undefined, options)
        return false
      }

      const prepared = buildSendPayload(
        message,
        options.attachments,
        options.project,
        undefined,
        undefined,
        options.deviceId
      )
      if (!prepared) {
        reportSendBlocked(
          'Wework default team is not configured',
          { hasDefaultTeam: Boolean(state.defaultTeam) },
          options
        )
        return false
      }
      if (prepared.activeDeviceId) {
        const activeDevice = findWorkbenchDevice(state.devices, prepared.activeDeviceId)
        if (!isWorkbenchDeviceOnline(activeDevice)) {
          const deviceName =
            getWorkbenchDeviceUnavailableDisplayName(activeDevice) ||
            i18n.t('workbench.current_device')
          reportSendBlocked(`${deviceName} 当前不可用`, undefined, options)
          return false
        }
        if (activeDevice && isDeviceBelowWeWorkVersion(activeDevice)) {
          reportSendBlocked(
            `${getWorkbenchDeviceDisplayName(activeDevice, prepared.activeDeviceId)} 版本低于 ${WEWORK_MIN_EXECUTOR_VERSION}`,
            undefined,
            options
          )
          return false
        }
      }

      const payload = options.executionModel
        ? applyExecutionModelOverride(prepared.payload, options.executionModel)
        : options.modelId
          ? { ...prepared.payload, force_override_bot_model: options.modelId }
          : prepared.payload
      return sendPreparedRuntimeMessage(message, payload, prepared.activeDeviceId, {
        initialGoal: options.initialGoal,
        initialSupervisor: options.initialSupervisor,
        collaborationMode: options.collaborationMode,
        deliveryId: options.deliveryId,
        cloudProjectId: options.cloudProjectId,
        modelSelection: options.modelSelection,
        additionalContext: options.additionalContext,
        ephemeral: options.hiddenFromSidebar,
        continuable: options.continuable,
        onError: options.onError,
        onRuntimeTaskOptimisticOpen: options.onRuntimeTaskOptimisticOpen,
        openInMainPane: false,
      })
    },
    [
      buildSendPayload,
      reportSendBlocked,
      sendPreparedRuntimeMessage,
      state.defaultTeam,
      state.devices,
    ]
  )

  const loadTurnFileChangesDiff = useCallback(
    async (
      subtaskId: string,
      messagesOverride?: WorkbenchMessage[],
      fileChangesOverride?: TurnFileChangesSummary,
      runtimeTaskOverride?: RuntimeTaskAddress | null
    ) => {
      const messageSource = messagesOverride ?? []
      const runtimeTask = runtimeTaskOverride ?? state.currentRuntimeTask
      const runtimeFileChanges = runtimeTask
        ? (fileChangesOverride ?? findFileChangesBySubtaskId(messageSource, subtaskId))
        : undefined
      if (runtimeFileChanges?.diff) return runtimeFileChanges.diff
      if (runtimeFileChanges) {
        const response = await executorClient.commands.executeCommand(
          runtimeFileChanges.device_id,
          {
            command_key: 'turn_file_changes_review',
            path: runtimeFileChanges.workspace_path,
            args: [runtimeFileChanges.artifact_id],
            timeout_seconds: 30,
            max_output_bytes: 5 * 1024 * 1024,
          }
        )
        const stdout = getCommandStdoutObject(response.stdout)
        if (
          !response.success ||
          !stdout ||
          stdout.success !== true ||
          typeof stdout.diff !== 'string'
        ) {
          throw new Error(
            String(
              stdout?.error || response.error || response.stderr || 'File changes review failed'
            )
          )
        }
        return stdout.diff
      }
      if (runtimeTask) {
        throw new Error('Runtime file changes artifact is unavailable')
      }

      const loadDiff = services.taskApi.getTurnFileChangesDiff
      if (!loadDiff) throw new Error('File changes review is unavailable')
      const response = await loadDiff(subtaskId)
      return response.diff
    },
    [executorClient, services.taskApi, state.currentRuntimeTask]
  )

  const revertTurnFileChanges = useCallback(
    async (
      subtaskId: string,
      messagesOverride?: WorkbenchMessage[],
      fileChangesOverride?: TurnFileChangesSummary,
      runtimeTaskOverride?: RuntimeTaskAddress | null
    ): Promise<TurnFileChangesSummary> => {
      const messageSource = messagesOverride ?? []
      const runtimeTask = runtimeTaskOverride ?? state.currentRuntimeTask
      const runtimeFileChanges = runtimeTask
        ? (fileChangesOverride ?? findFileChangesBySubtaskId(messageSource, subtaskId))
        : undefined
      if (runtimeFileChanges && runtimeTask) {
        const publishFileChanges = (fileChanges: TurnFileChangesSummary) => {
          applyRuntimeConversationAction(runtimeTask, {
            type: 'file_changes_updated',
            subtaskId,
            fileChanges,
          })
          return fileChanges
        }
        try {
          const response = await executorClient.runtime.revertRuntimeFileChanges({
            address: runtimeTask,
            fileChanges: runtimeFileChanges,
          })
          const fileChanges = normalizeTurnFileChanges(
            response.fileChanges ?? response.file_changes
          )
          if (!fileChanges) {
            throw new Error('Invalid file changes response')
          }
          return publishFileChanges({
            ...fileChanges,
            diff: runtimeFileChanges.diff,
            revertible: runtimeFileChanges.revertible ?? true,
          })
        } catch (error) {
          if (error instanceof ApiError && isRecord(error.detail)) {
            const fileChanges = normalizeTurnFileChanges(error.detail.file_changes)
            if (fileChanges) {
              return publishFileChanges({
                ...fileChanges,
                diff: runtimeFileChanges.diff,
                revertible: runtimeFileChanges.revertible ?? true,
              })
            }
          }
          throw error
        }
      }
      if (runtimeTask) {
        throw new Error('Runtime file changes artifact is unavailable')
      }
      const revert = services.taskApi.revertTurnFileChanges
      if (!revert) throw new Error('File changes revert is unavailable')
      try {
        const response = await revert(subtaskId)
        const fileChanges = normalizeTurnFileChanges(response.file_changes)
        if (!fileChanges) {
          throw new Error('Invalid file changes response')
        }
        return fileChanges
      } catch (error) {
        if (error instanceof ApiError && isRecord(error.detail)) {
          const fileChanges = normalizeTurnFileChanges(error.detail.file_changes)
          if (fileChanges) {
            return fileChanges
          }
        }
        throw error
      }
    },
    [executorClient, services.taskApi, state.currentRuntimeTask]
  )

  const pauseCurrentResponse = useCallback(async () => {
    if (!state.currentRuntimeTask) return

    const ack = await executorClient.runtime.cancelRuntimeTask(state.currentRuntimeTask)
    if (!ack.accepted) {
      dispatch({
        type: 'error_set',
        error: normalizeGuidanceError(ack.error ?? '取消当前回复失败'),
      })
      return
    }
    await refreshWorkLists()
  }, [dispatch, executorClient, refreshWorkLists, state.currentRuntimeTask])

  return {
    sendRuntimePaneMessage,
    interruptAndSendRuntimePaneMessage,
    sendRuntimePaneGuidance,
    compactRuntimePaneTask,
    editLastUserMessage,
    cancelRuntimePaneTask,
    sendCurrentInput,
    createTemporaryRuntimeTask,
    createEphemeralRuntimeTask,
    createProjectRuntimeTask,
    retryFailedMessage,
    pauseCurrentResponse,
    loadTurnFileChangesDiff,
    revertTurnFileChanges,
  }
}

function buildOptimisticRuntimeWorkspace({
  baseWorkspace,
  devices,
  deviceId,
  workspacePath,
  projectId,
  workspaceKind,
}: {
  baseWorkspace?: RuntimeDeviceWorkspace | null
  devices: WorkbenchState['devices']
  deviceId: string
  workspacePath: string
  projectId: number | null
  workspaceKind?: RuntimeDeviceWorkspace['workspaceKind']
}): RuntimeDeviceWorkspace {
  const device = findWorkbenchDevice(devices, deviceId)
  return {
    ...baseWorkspace,
    projectId: projectId ?? baseWorkspace?.projectId,
    deviceId,
    deviceName: device?.name ?? baseWorkspace?.deviceName ?? deviceId,
    deviceStatus: device?.status ?? baseWorkspace?.deviceStatus ?? null,
    workspacePath,
    workspaceKind:
      workspaceKind ?? baseWorkspace?.workspaceKind ?? (projectId ? 'workspace' : 'chat'),
    mapped: baseWorkspace?.mapped ?? Boolean(projectId),
    available: baseWorkspace?.available ?? (device ? device.status !== 'offline' : true),
    tasks: [],
  }
}

function buildOptimisticRuntimeTask({
  taskId,
  workspacePath,
  title,
  runtime,
  status = 'creating',
  queuePosition,
  workspaceKind,
  error,
  modelSelection,
}: {
  taskId: string
  workspacePath: string
  title: string
  runtime: RuntimeTaskSummary['runtime']
  status?: 'creating' | 'failed' | 'queued' | 'running'
  queuePosition?: number | null
  workspaceKind?: RuntimeTaskSummary['workspaceKind']
  error?: string | null
  modelSelection?: ModelSelectionConfig | null
}): RuntimeTaskSummary {
  const now = new Date().toISOString()
  return {
    taskId,
    ...(taskId ? { taskId } : {}),
    workspacePath,
    title,
    runtime,
    ...(workspaceKind ? { workspaceKind } : {}),
    createdAt: now,
    updatedAt: now,
    running: status === 'creating' || status === 'running',
    status,
    optimistic: true,
    ...(queuePosition != null ? { queuePosition } : {}),
    ...(error ? { error } : {}),
    ...(modelSelection ? { modelSelection } : {}),
  }
}

function modelSelectionFromCreateRequest(
  request: RuntimeTaskCreateRequest
): ModelSelectionConfig | null {
  if (request.modelSelection?.modelName) {
    return request.modelSelection
  }

  if (!request.modelId) {
    return null
  }

  return {
    modelName: request.modelId,
    modelType: request.modelType ?? null,
    options: request.modelOptions ?? {},
  }
}

export function applyExecutionModelOverride(
  payload: ChatSendPayload,
  executionModel: {
    modelId?: string | null
    modelType?: string | null
    modelOptions?: ModelOptions
  }
): ChatSendPayload {
  const next: ChatSendPayload = { ...payload }
  delete next.force_override_bot_model
  delete next.force_override_bot_model_type
  delete next.model_options
  if (executionModel.modelId) {
    next.force_override_bot_model = executionModel.modelId
  }
  if (executionModel.modelType) {
    next.force_override_bot_model_type = executionModel.modelType as ModelType
  }
  if (executionModel.modelOptions && Object.keys(executionModel.modelOptions).length > 0) {
    next.model_options = executionModel.modelOptions
  }
  return next
}

function runtimeAddressLog(address: RuntimeTaskAddress): Record<string, unknown> {
  return {
    deviceId: address.deviceId,
    taskId: address.taskId,
    workspacePath: address.workspacePath ?? null,
    hasRuntimeHandle: Boolean(address.runtimeHandle),
    runtimeHandleKeys: address.runtimeHandle ? Object.keys(address.runtimeHandle).sort() : [],
  }
}

function debugRuntimeCreateFlow(event: string, details: Record<string, unknown>) {
  if (!isRuntimeDebugEnabled()) return
  console.debug('[Wework] Runtime create flow', {
    event,
    ...details,
  })
}

function runtimeLaunchNowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function logRuntimeTaskLaunchTiming(
  stage: string,
  startedAt: number,
  details: Record<string, unknown>
) {
  console.info('[Wework] Runtime task launch timing', {
    stage,
    elapsedMs: Math.round(runtimeLaunchNowMs() - startedAt),
    ...details,
  })
}

function logRuntimeTaskLaunchPaintTiming(startedAt: number, details: Record<string, unknown>) {
  if (typeof requestAnimationFrame !== 'function') return
  requestAnimationFrame(() => {
    logRuntimeTaskLaunchTiming('optimistic-open-frame-ready', startedAt, details)
    requestAnimationFrame(() => {
      logRuntimeTaskLaunchTiming('optimistic-open-frame-painted', startedAt, details)
    })
  })
}

function runtimeLaunchErrorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

function summarizeModelOptions(modelOptions: ModelOptions | undefined): Record<string, unknown> {
  if (!modelOptions) return {}
  return {
    keys: Object.keys(modelOptions),
    collaborationMode: modelOptions.collaborationMode ?? modelOptions.collaboration_mode ?? null,
    reasoning: modelOptions.reasoning ?? null,
    summary: modelOptions.summary ?? null,
    speed: modelOptions.speed ?? modelOptions.service_tier ?? null,
  }
}

function isRuntimeDebugEnabled(): boolean {
  return globalThis.localStorage?.getItem('wework:debug-runtime') === '1'
}
