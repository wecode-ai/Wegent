import { useCallback } from 'react'
import type { Dispatch } from 'react'
import { ApiError } from '@/api/http'
import { WEWORK_CLIENT_ORIGIN } from '@/api/backend/backendServices'
import type { ExecutorClient } from '@/api/executorAccess'
import i18n from '@/i18n'
import { getModelExecutionOverride } from '@/features/cloud-connection/modelExecution'
import { localModelIdFromModelName } from '@/features/model-settings/localModelSettings'
import { appendCodeCommentContexts } from '@/lib/code-comment-context'
import { getPreferredStandaloneDeviceId } from '@/lib/device-selection'
import {
  WEWORK_MIN_EXECUTOR_VERSION,
  isDeviceBelowWeWorkVersion,
  isWeWorkCompatibleDevice,
} from '@/lib/device-capabilities'
import { supportsGitWorktreeExecution } from '@/lib/projectClassification'
import { localRuntimeAttachments, remoteAttachmentIds } from '@/lib/runtime-attachments'
import {
  findWorkbenchDevice,
  getActiveWorkbenchDeviceId,
  getWorkbenchDeviceDisplayName,
  isWorkbenchDeviceOnline,
} from '@/lib/workbench-device'
import type {
  Attachment,
  ChatSendPayload,
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
  SkillRef,
  TurnFileChangesSummary,
  UnifiedModel,
} from '@/types/api'
import type { WorkbenchMessage, WorkbenchState } from '@/types/workbench'
import { normalizeTurnFileChanges } from './turnFileChanges'
import type {
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
} from './workbenchRuntimeHelpers'
import type { WorkbenchRuntimeTasks } from './useWorkbenchRuntimeTasks'
import { findFileChangesBySubtaskId } from './runtimePaneMessages'
import {
  inferRuntimeName,
  resolveAutomaticModel,
  selectedModelExecutionFields,
} from './runtimeModelSelection'
import type { WorkbenchServices } from './workbenchServices'

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
  currentRuntimeTaskRunning: boolean
  projectExecutionMode: string
  projectWorktreeBranch: string | null
  isOptionsLocked: boolean
  attachmentSelection: RuntimeMessagingAttachmentSelection
  modelSelection: RuntimeMessagingModelSelection
  skillSelection: RuntimeMessagingSkillSelection
  refreshWorkLists: () => Promise<void>
  rememberExecutionDevice: (deviceId: string) => void
}

function isConfiguredLocalModel(model: UnifiedModel | null): boolean {
  if (!model) return false
  const override = getModelExecutionOverride(model)
  const modelName = override?.modelName ?? model.name
  return localModelIdFromModelName(modelName) !== null
}

function isLocalDeviceTarget(
  devices: WorkbenchState['devices'],
  deviceId?: string | null
): boolean {
  if (!deviceId) return false
  const device = findWorkbenchDevice(devices, deviceId)
  return device?.device_type === 'local'
}

function runtimeThreadId(address?: RuntimeTaskAddress | null): string | null {
  const handle = address?.runtimeHandle
  if (!isRecord(handle)) return null
  const threadId = handle.sessionId ?? handle.session_id ?? handle.threadId ?? handle.thread_id
  return typeof threadId === 'string' && threadId.trim() ? threadId : null
}

export function useWorkbenchRuntimeMessaging({
  state,
  dispatch,
  executorClient,
  services,
  runtimeTasks,
  currentRuntimeTaskRunning,
  projectExecutionMode,
  projectWorktreeBranch,
  isOptionsLocked,
  attachmentSelection,
  modelSelection,
  skillSelection,
  refreshWorkLists,
  rememberExecutionDevice,
}: UseWorkbenchRuntimeMessagingOptions) {
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

  const sendRuntimePaneMessage = useCallback(
    async (request: RuntimeSendRequest, options?: RuntimePaneActionOptions): Promise<boolean> => {
      dispatch({ type: 'runtime_task_started', address: request.address })
      try {
        const response = await executorClient.runtime.sendRuntimeMessage(request)
        if (!response.accepted) {
          throw new Error(response.error || '发送失败')
        }
        try {
          await refreshWorkLists()
        } catch (error) {
          console.warn('[Wework] Runtime send accepted but work list refresh failed', {
            taskId: response.taskId ?? request.address.taskId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        return true
      } catch (error) {
        dispatch({ type: 'runtime_task_settled', address: request.address })
        console.warn('[Wework] Runtime send failed', {
          taskId: request.address.taskId,
          deviceId: request.address.deviceId,
          workspacePath: request.address.workspacePath ?? null,
          addressKeys: Object.keys(request.address as unknown as Record<string, unknown>).sort(),
          error: error instanceof Error ? error.message : String(error),
        })
        reportError(error instanceof Error ? error.message : '发送失败', options)
        return false
      }
    },
    [dispatch, executorClient, refreshWorkLists, reportError]
  )

  const editLastUserMessage = useCallback(
    async (request: RuntimeRollbackRequest): Promise<boolean> => {
      try {
        const response = await executorClient.runtime.rollbackRuntimeTask(request)
        if (!response.accepted) {
          throw new Error(response.error || '编辑失败')
        }
        try {
          await refreshWorkLists()
        } catch (error) {
          console.warn('[Wework] Runtime rollback accepted but work list refresh failed', {
            taskId: response.taskId ?? request.address.taskId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        return true
      } catch (error) {
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
    [dispatch, executorClient, refreshWorkLists]
  )

  const sendRuntimePaneGuidance = useCallback(
    async (request: RuntimeGuidanceRequest): Promise<RuntimePaneGuidanceResult> => {
      try {
        const response = await executorClient.runtime.guideRuntimeTask(request)
        if (response.accepted === false || response.success === false) {
          return {
            sent: false,
            code: response.code,
            error: response.error || '引导发送失败',
          }
        }
        try {
          await refreshWorkLists()
        } catch (error) {
          console.warn('[Wework] Runtime guidance accepted but work list refresh failed', {
            taskId: response.taskId ?? response.task_id ?? request.address.taskId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        return { sent: true, code: response.code, error: response.error }
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
    [executorClient, refreshWorkLists, reportError]
  )

  const compactRuntimePaneTask = useCallback(
    async (address: RuntimeTaskAddress, options?: RuntimePaneActionOptions): Promise<boolean> => {
      dispatch({ type: 'runtime_task_started', address })
      try {
        const response = await executorClient.runtime.compactRuntimeTask({ address })
        if (!response.accepted) {
          throw new Error(response.error || '压缩上下文失败')
        }
        try {
          await refreshWorkLists()
        } catch (error) {
          console.warn('[Wework] Runtime compact accepted but work list refresh failed', {
            taskId: response.taskId ?? address.taskId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        dispatch({ type: 'runtime_task_settled', address })
        return true
      } catch (error) {
        dispatch({ type: 'runtime_task_settled', address })
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
    [dispatch, executorClient, refreshWorkLists, reportError]
  )

  const cancelRuntimePaneTask = useCallback(
    async (address: RuntimeTaskAddress, options?: RuntimePaneActionOptions): Promise<boolean> => {
      try {
        const ack = await executorClient.runtime.cancelRuntimeTask(address)
        if (!ack.accepted) {
          reportError(normalizeGuidanceError(ack.error ?? '取消当前回复失败'), options)
          return false
        }
        await refreshWorkLists()
        return true
      } catch (error) {
        reportError(
          normalizeGuidanceError(error instanceof Error ? error.message : '取消当前回复失败'),
          options
        )
        return false
      }
    },
    [executorClient, refreshWorkLists, reportError]
  )

  const buildSendPayload = useCallback(
    (
      message: string,
      sourceAttachments?: Attachment[],
      projectOverride?: ProjectWithTasks | null
    ): { payload: ChatSendPayload; activeDeviceId?: string } | null => {
      if (!state.defaultTeam) return null
      const activeProject = projectOverride === undefined ? state.currentProject : projectOverride
      const selectedProjectWorkspace = findProjectDeviceWorkspace(
        state.runtimeWork,
        activeProject?.id,
        state.selectedDeviceWorkspaceId
      )
      const activeDeviceId =
        activeProject && selectedProjectWorkspace
          ? selectedProjectWorkspace.deviceId
          : getActiveWorkbenchDeviceId({
              currentProject: activeProject,
              standaloneDeviceId: getPreferredStandaloneDeviceId(
                state.devices,
                state.standaloneDeviceId
              ),
            })

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

      if (!isOptionsLocked && skillSelection.selectedSkills.length > 0) {
        payload.additional_skills = skillSelection.selectedSkills
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
        'initialGoal' | 'onError' | 'onRuntimeTaskOptimisticOpen'
      > & {
        ephemeral?: boolean
        openInMainPane?: boolean
        refreshWorkListsOnResolve?: boolean
        sideSource?: RuntimeTaskAddress | null
      }
    ): Promise<RuntimeTaskAddress | false> => {
      const projectId = payload.project_id && payload.project_id > 0 ? payload.project_id : null
      const selectedModel =
        modelSelection.getSelectedModel?.() ??
        modelSelection.selectedModel ??
        resolveAutomaticModel(modelSelection.models)
      const selectedModelOptions =
        modelSelection.getSelectedModelOptions?.() ?? modelSelection.selectedModelOptions
      const runtime = inferRuntimeName(selectedModel)
      const taskSeed = createRuntimeTaskId(runtime)
      const taskId = createRuntimeTaskIdFromSeed(taskSeed)
      const selectedProjectWorkspace = findProjectDeviceWorkspace(
        state.runtimeWork,
        projectId,
        state.selectedDeviceWorkspaceId
      )
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
          selectedProjectWorkspace.id != null
            ? {
                projectId,
                deviceWorkspaceId: selectedProjectWorkspace.id,
              }
            : {
                deviceId: selectedProjectWorkspace.deviceId,
                workspacePath: selectedProjectWorkspace.workspacePath,
              }
      } else {
        let workspacePath = state.standaloneWorkspacePath
        if (!workspacePath && activeDeviceId) {
          try {
            workspacePath = await createConversationWorkspace(
              executorClient.commands,
              activeDeviceId,
              displayMessage,
              taskId
            )
          } catch (error) {
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

      if (
        isConfiguredLocalModel(selectedModel) &&
        !isLocalDeviceTarget(state.devices, optimisticDeviceId)
      ) {
        reportSendBlocked(i18n.t('workbench.local_model_cloud_device_blocked'), undefined, options)
        return false
      }

      const createRequest: RuntimeTaskCreateRequest = {
        ...runtimeTaskTarget,
        taskId,
        teamId: payload.team_id,
        runtime,
        message: payload.message,
        title: buildRuntimeTaskTitle(displayMessage, payload.title),
        modelId: payload.force_override_bot_model,
        modelType: payload.force_override_bot_model_type ?? null,
        modelOptions: payload.model_options ?? {},
        additionalSkills: payload.additional_skills ?? [],
        attachmentIds: payload.attachment_ids ?? [],
        attachments: payload.attachments ?? [],
        execution: payload.execution,
        ...(options?.ephemeral ? { ephemeral: true } : {}),
        ...(options?.sideSource ? { sideSource: options.sideSource } : {}),
        ...(options?.initialGoal ? { initialGoal: options.initialGoal } : {}),
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
      options?.onRuntimeTaskOptimisticOpen?.(optimisticAddress)
      if (options?.openInMainPane !== false) {
        runtimeTasks.openRuntimeTaskView(optimisticAddress, runtimeProject, { navigate: true })
      }
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
            modelSelection: createModelSelection,
          }),
        })
      }
      attachmentSelection.resetAttachments()

      try {
        const response = await executorClient.runtime.createRuntimeTask(createRequest)
        if (!response.accepted) {
          throw new Error(response.error || '发送失败')
        }
        const address: RuntimeTaskAddress = {
          deviceId: response.deviceId || optimisticAddress.deviceId,
          taskId: response.taskId || optimisticAddress.taskId,
          workspacePath: response.workspacePath || optimisticAddress.workspacePath,
          runtimeHandle: response.runtimeHandle ?? optimisticAddress.runtimeHandle,
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
            }),
            task: buildOptimisticRuntimeTask({
              taskId: address.taskId,
              workspacePath: resolvedWorkspacePath,
              title: createRequest.title ?? buildRuntimeTaskTitle(displayMessage, payload.title),
              runtime,
              modelSelection: createModelSelection,
            }),
          })
        }
        if (!resolvedSameIdentity) {
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
          if (options?.openInMainPane !== false) {
            runtimeTasks.openRuntimeTaskView(address, runtimeProject, { navigate: true })
          }
        }
        if (options?.refreshWorkListsOnResolve !== false) {
          await refreshWorkLists()
        }
        if (options?.openInMainPane !== false) {
          runtimeTasks.openRuntimeTaskView(address, runtimeProject, { navigate: true })
          dispatch({ type: 'blank_chat_committed' })
        }
        return address
      } catch (error) {
        const message = error instanceof Error ? error.message : '发送失败'
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
      dispatch,
      executorClient,
      modelSelection,
      refreshWorkLists,
      rememberExecutionDevice,
      reportError,
      reportSendBlocked,
      runtimeTasks,
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

      if (state.currentRuntimeTask) {
        if (hasCodeComments) {
          reportSendBlocked('当前 LocalTask 暂不支持代码评论', undefined, options)
          return false
        }
        if (currentRuntimeTaskRunning) {
          reportSendBlocked(i18n.t('workbench.runtime_task_running_message'), undefined, options)
          return false
        }
        if (
          isConfiguredLocalModel(runtimeSelectedModel) &&
          !isLocalDeviceTarget(state.devices, state.currentRuntimeTask.deviceId)
        ) {
          reportSendBlocked(
            i18n.t('workbench.local_model_cloud_device_blocked'),
            undefined,
            options
          )
          return false
        }
        const currentAttachments = attachmentSelection.attachments
        const attachmentIds = remoteAttachmentIds(currentAttachments)
        const attachments = localRuntimeAttachments(currentAttachments)
        const sent = await sendRuntimePaneMessage(
          {
            address: state.currentRuntimeTask,
            message: payloadMessage,
            ...runtimeModelFields,
            ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
          },
          options
        )
        if (sent) {
          attachmentSelection.resetAttachments()
        }
        return sent
      }

      const prepared = buildSendPayload(payloadMessage)
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
          const deviceName = getWorkbenchDeviceDisplayName(activeDevice, prepared.activeDeviceId)
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
          initialGoal: options?.initialGoal,
          onError: options?.onError,
          onRuntimeTaskOptimisticOpen: options?.onRuntimeTaskOptimisticOpen,
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
      currentRuntimeTaskRunning,
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
    async (messageId: string, messagesOverride?: WorkbenchMessage[]) => {
      const messageSource = messagesOverride ?? []
      const failedMessageIndex = messageSource.findIndex(
        message =>
          message.id === messageId && message.role === 'assistant' && message.status === 'failed'
      )
      if (failedMessageIndex === -1) {
        dispatch({ type: 'error_set', error: '未找到可重试的失败消息' })
        return
      }

      const previousUserMessage = [...messageSource]
        .slice(0, failedMessageIndex)
        .reverse()
        .find(message => message.role === 'user')
      if (!previousUserMessage) {
        dispatch({ type: 'error_set', error: '未找到可重试的用户消息' })
        return
      }

      if (state.currentRuntimeTask) {
        if (currentRuntimeTaskRunning) {
          reportSendBlocked(i18n.t('workbench.runtime_task_running_message'))
          return
        }
        try {
          const runtimeSelectedModel =
            modelSelection.getSelectedModel?.() ??
            modelSelection.selectedModel ??
            resolveAutomaticModel(modelSelection.models)
          const runtimeSelectedModelOptions =
            modelSelection.getSelectedModelOptions?.() ?? modelSelection.selectedModelOptions
          if (
            isConfiguredLocalModel(runtimeSelectedModel) &&
            !isLocalDeviceTarget(state.devices, state.currentRuntimeTask.deviceId)
          ) {
            reportSendBlocked(i18n.t('workbench.local_model_cloud_device_blocked'))
            return
          }
          const response = await executorClient.runtime.sendRuntimeMessage({
            address: state.currentRuntimeTask,
            message: previousUserMessage.content,
            ...selectedModelExecutionFields(runtimeSelectedModel, runtimeSelectedModelOptions),
          })
          if (!response.accepted) {
            throw new Error(response.error || '发送失败')
          }
          await refreshWorkLists()
        } catch (error) {
          dispatch({
            type: 'error_set',
            error: error instanceof Error ? error.message : '发送失败',
          })
        }
        return
      }

      reportSendBlocked('当前没有可重试的 LocalTask')
    },
    [
      currentRuntimeTaskRunning,
      dispatch,
      executorClient,
      modelSelection,
      refreshWorkLists,
      reportSendBlocked,
      state.currentRuntimeTask,
      state.devices,
    ]
  )

  const createTemporaryRuntimeTask = useCallback(
    async (
      input: string,
      options?: CreateTemporaryRuntimeTaskOptions
    ): Promise<RuntimeTaskAddress | false> => {
      const message = input.trim()
      if (!message) {
        reportSendBlocked('请输入内容后再发送', undefined, options)
        return false
      }
      if (!options?.source || !runtimeThreadId(options.source)) {
        reportSendBlocked('请先打开一个已有对话后再开始临时聊天', undefined, options)
        return false
      }

      const prepared = buildSendPayload(message, undefined, options?.project)
      if (!prepared) {
        reportSendBlocked(
          'Wework default team is not configured',
          { hasDefaultTeam: Boolean(state.defaultTeam) },
          options
        )
        return false
      }

      const selectedModel =
        modelSelection.getSelectedModel?.() ??
        modelSelection.selectedModel ??
        resolveAutomaticModel(modelSelection.models)
      if (
        prepared.activeDeviceId &&
        isConfiguredLocalModel(selectedModel) &&
        !isLocalDeviceTarget(state.devices, prepared.activeDeviceId)
      ) {
        reportSendBlocked(i18n.t('workbench.local_model_cloud_device_blocked'), undefined, options)
        return false
      }

      return sendPreparedRuntimeMessage(message, prepared.payload, prepared.activeDeviceId, {
        onError: options?.onError,
        ephemeral: true,
        sideSource: options?.source,
        openInMainPane: false,
        refreshWorkListsOnResolve: false,
      })
    },
    [
      buildSendPayload,
      modelSelection,
      reportSendBlocked,
      sendPreparedRuntimeMessage,
      state.defaultTeam,
      state.devices,
    ]
  )

  const loadTurnFileChangesDiff = useCallback(
    async (subtaskId: string, messagesOverride?: WorkbenchMessage[]) => {
      const messageSource = messagesOverride ?? []
      const runtimeFileChanges = state.currentRuntimeTask
        ? findFileChangesBySubtaskId(messageSource, subtaskId)
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
      if (state.currentRuntimeTask) {
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
      messagesOverride?: WorkbenchMessage[]
    ): Promise<TurnFileChangesSummary> => {
      const messageSource = messagesOverride ?? []
      const runtimeFileChanges = state.currentRuntimeTask
        ? findFileChangesBySubtaskId(messageSource, subtaskId)
        : undefined
      if (runtimeFileChanges && state.currentRuntimeTask) {
        try {
          const response = await executorClient.runtime.revertRuntimeFileChanges({
            address: state.currentRuntimeTask,
            fileChanges: runtimeFileChanges,
          })
          const fileChanges = normalizeTurnFileChanges(
            response.fileChanges ?? response.file_changes
          )
          if (!fileChanges) {
            throw new Error('Invalid file changes response')
          }
          return {
            ...fileChanges,
            diff: runtimeFileChanges.diff,
            revertible: runtimeFileChanges.revertible ?? true,
          }
        } catch (error) {
          if (error instanceof ApiError && isRecord(error.detail)) {
            const fileChanges = normalizeTurnFileChanges(error.detail.file_changes)
            if (fileChanges) {
              return {
                ...fileChanges,
                diff: runtimeFileChanges.diff,
                revertible: runtimeFileChanges.revertible ?? true,
              }
            }
          }
          throw error
        }
      }
      if (state.currentRuntimeTask) {
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
    sendRuntimePaneGuidance,
    compactRuntimePaneTask,
    editLastUserMessage,
    cancelRuntimePaneTask,
    sendCurrentInput,
    createTemporaryRuntimeTask,
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
}: {
  baseWorkspace?: RuntimeDeviceWorkspace | null
  devices: WorkbenchState['devices']
  deviceId: string
  workspacePath: string
  projectId: number | null
}): RuntimeDeviceWorkspace {
  const device = findWorkbenchDevice(devices, deviceId)
  return {
    ...baseWorkspace,
    projectId: projectId ?? baseWorkspace?.projectId,
    deviceId,
    deviceName: device?.name ?? baseWorkspace?.deviceName ?? deviceId,
    deviceStatus: device?.status ?? baseWorkspace?.deviceStatus ?? null,
    workspacePath,
    workspaceKind: baseWorkspace?.workspaceKind ?? (projectId ? 'workspace' : 'chat'),
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
  error,
  modelSelection,
}: {
  taskId: string
  workspacePath: string
  title: string
  runtime: RuntimeTaskSummary['runtime']
  status?: 'creating' | 'failed'
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
    createdAt: now,
    updatedAt: now,
    running: status === 'creating',
    status,
    optimistic: true,
    ...(error ? { error } : {}),
    ...(modelSelection ? { modelSelection } : {}),
  }
}

function modelSelectionFromCreateRequest(
  request: RuntimeTaskCreateRequest
): ModelSelectionConfig | null {
  if (!request.modelId) {
    return null
  }

  return {
    modelName: request.modelId,
    modelType: request.modelType ?? null,
    options: request.modelOptions ?? {},
  }
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
