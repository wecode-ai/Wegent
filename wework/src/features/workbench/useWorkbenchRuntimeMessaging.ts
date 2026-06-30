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
import {
  findWorkbenchDevice,
  getActiveWorkbenchDeviceId,
  getWorkbenchDeviceDisplayName,
  isWorkbenchDeviceOnline,
} from '@/lib/workbench-device'
import type {
  Attachment,
  ChatSendPayload,
  LocalTaskSummary,
  ModelOptions,
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
import type { SendCurrentInputOptions } from './workbenchContextTypes'
import { DEVICE_STATUS_LABELS, normalizeGuidanceError } from './workbenchProviderHelpers'
import type { WorkbenchAction } from './workbenchReducer'
import {
  EMPTY_MESSAGE_TASK_TITLE,
  STANDALONE_PROJECT_ID,
  buildRuntimeTaskTitle,
  createConversationWorkspace,
  createRuntimeLocalTaskId,
  findProjectDeviceWorkspace,
  getCommandStdoutObject,
  isRecord,
  isSameRuntimeTaskIdentity,
} from './workbenchRuntimeHelpers'
import type { WorkbenchRuntimeTasks } from './useWorkbenchRuntimeTasks'
import { findActiveAssistantMessage, findFileChangesByTurnId } from './runtimePaneMessages'
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
  const reportSendBlocked = useCallback(
    (error: string, details?: Record<string, unknown>) => {
      console.warn('[Wework] send blocked:', error, details ?? {})
      dispatch({ type: 'error_set', error })
    },
    [dispatch]
  )

  const sendRuntimePaneMessage = useCallback(
    async (request: RuntimeSendRequest): Promise<boolean> => {
      try {
        const response = await executorClient.runtime.sendRuntimeMessage(request)
        if (!response.accepted) {
          throw new Error(response.error || '发送失败')
        }
        await refreshWorkLists()
        return true
      } catch (error) {
        dispatch({
          type: 'error_set',
          error: error instanceof Error ? error.message : '发送失败',
        })
        return false
      }
    },
    [dispatch, executorClient, refreshWorkLists]
  )

  const cancelRuntimePaneTask = useCallback(
    async (address: RuntimeTaskAddress): Promise<boolean> => {
      const ack = await executorClient.runtime.cancelRuntimeTask(address)
      if (!ack.accepted) {
        dispatch({
          type: 'error_set',
          error: normalizeGuidanceError(ack.error ?? '取消当前回复失败'),
        })
        return false
      }
      await refreshWorkLists()
      return true
    },
    [dispatch, executorClient, refreshWorkLists]
  )

  const buildSendPayload = useCallback(
    (
      message: string,
      sourceAttachments?: Attachment[]
    ): { payload: ChatSendPayload; activeDeviceId?: string } | null => {
      if (!state.defaultTeam) return null
      const activeProject = state.currentProject
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
        modelSelection.selectedModel ?? resolveAutomaticModel(modelSelection.models)

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

      if (selectedModel) {
        const executionModel = selectedModelExecutionFields(
          selectedModel,
          modelSelection.selectedModelOptions
        )
        payload.force_override_bot_model = executionModel.modelId
        if (executionModel.modelType) {
          payload.force_override_bot_model_type = executionModel.modelType
        }
        if (
          modelSelection.selectedModel &&
          executionModel.modelOptions &&
          Object.keys(executionModel.modelOptions).length > 0
        ) {
          payload.model_options = executionModel.modelOptions
        }
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
      options?: Pick<SendCurrentInputOptions, 'onRuntimeTaskOptimisticOpen'>
    ): Promise<RuntimeTaskAddress | false> => {
      const projectId = payload.project_id && payload.project_id > 0 ? payload.project_id : null
      const selectedModel =
        modelSelection.selectedModel ?? resolveAutomaticModel(modelSelection.models)
      const runtime = inferRuntimeName(selectedModel)
      const localTaskId = createRuntimeLocalTaskId(runtime)
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
      if (projectId) {
        if (!selectedProjectWorkspace) {
          reportSendBlocked('请选择任务运行位置')
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
              displayMessage
            )
          } catch (error) {
            reportSendBlocked(error instanceof Error ? error.message : '创建对话工作区失败')
            return false
          }
        }
        if (!activeDeviceId || !workspacePath) {
          reportSendBlocked('请选择项目或打开设备工作区后再发送')
          return false
        }
        optimisticDeviceId = activeDeviceId
        runtimeTaskTarget = {
          deviceId: activeDeviceId,
          workspacePath,
        }
      }

      const createRequest: RuntimeTaskCreateRequest = {
        ...runtimeTaskTarget,
        localTaskId,
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
      }
      const optimisticAddress: RuntimeTaskAddress = {
        deviceId: optimisticDeviceId,
        workspacePath:
          'workspacePath' in runtimeTaskTarget ? runtimeTaskTarget.workspacePath : undefined,
        localTaskId,
      }
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
        localTaskId,
        runtime,
        projectId,
        optimisticAddress: runtimeAddressLog(optimisticAddress),
        hasSelectedProjectWorkspace: Boolean(selectedProjectWorkspace),
        optimisticWorkspacePath: optimisticWorkspacePath ?? null,
      })
      options?.onRuntimeTaskOptimisticOpen?.(optimisticAddress)
      runtimeTasks.openRuntimeTaskView(optimisticAddress, runtimeProject, { navigate: true })
      attachmentSelection.resetAttachments()

      try {
        const response = await executorClient.runtime.createRuntimeTask(createRequest)
        if (!response.accepted) {
          throw new Error(response.error || '发送失败')
        }
        const address: RuntimeTaskAddress = {
          deviceId: response.deviceId || optimisticAddress.deviceId,
          workspacePath: response.workspacePath || optimisticAddress.workspacePath,
          localTaskId: response.localTaskId || optimisticAddress.localTaskId,
        }
        debugRuntimeCreateFlow('create-resolved', {
          localTaskId,
          runtime,
          projectId,
          accepted: response.accepted,
          optimisticAddress: runtimeAddressLog(optimisticAddress),
          resolvedAddress: runtimeAddressLog(address),
          sameIdentity: isSameRuntimeTaskIdentity(optimisticAddress, address),
          responseHasWorkspacePath: Boolean(response.workspacePath),
          responseHasLocalTaskId: Boolean(response.localTaskId),
        })
        const resolvedWorkspacePath = address.workspacePath ?? optimisticWorkspacePath
        if (resolvedWorkspacePath) {
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
              localTaskId: address.localTaskId,
              workspacePath: resolvedWorkspacePath,
              title: createRequest.title ?? buildRuntimeTaskTitle(displayMessage, payload.title),
              runtime,
            }),
          })
        }
        if (!isSameRuntimeTaskIdentity(optimisticAddress, address)) {
          if (address.deviceId) rememberExecutionDevice(address.deviceId)
          debugRuntimeCreateFlow('create-final-open', {
            localTaskId,
            runtime,
            previousAddress: runtimeAddressLog(optimisticAddress),
            finalAddress: runtimeAddressLog(address),
          })
          options?.onRuntimeTaskOptimisticOpen?.(address, {
            previousAddress: optimisticAddress,
          })
          runtimeTasks.openRuntimeTaskView(address, runtimeProject, { navigate: true })
        }
        await refreshWorkLists()
        runtimeTasks.openRuntimeTaskView(address, runtimeProject, { navigate: true })
        return address
      } catch (error) {
        dispatch({ type: 'runtime_task_optimistic_removed', address: optimisticAddress })
        if (runtimeTasks.isCurrentRuntimeTask(optimisticAddress)) {
          runtimeTasks.clearCurrentRuntimeTaskView()
        }
        dispatch({
          type: 'error_set',
          error: error instanceof Error ? error.message : '发送失败',
        })
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
        reportSendBlocked('请输入内容或添加附件后再发送')
        return false
      }
      const message =
        trimmedMessage || (hasCodeComments ? i18n.t('workbench.code_comment_fallback') : '')
      const payloadMessage = appendCodeCommentContexts(message, effectiveCodeCommentContexts)
      const runtimeSelectedModel =
        modelSelection.selectedModel ?? resolveAutomaticModel(modelSelection.models)
      const runtimeModelFields = selectedModelExecutionFields(
        runtimeSelectedModel,
        modelSelection.selectedModelOptions
      )

      if (state.currentRuntimeTask) {
        if (hasCodeComments) {
          reportSendBlocked('当前 LocalTask 暂不支持代码评论')
          return false
        }
        if (currentRuntimeTaskRunning) {
          reportSendBlocked(i18n.t('workbench.runtime_task_running_message'))
          return false
        }
        const currentAttachments = attachmentSelection.attachments
        const attachmentIds = remoteAttachmentIds(currentAttachments)
        const attachments = localRuntimeAttachments(currentAttachments)
        const sent = await sendRuntimePaneMessage({
          address: state.currentRuntimeTask,
          message: payloadMessage,
          ...runtimeModelFields,
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        })
        if (sent) {
          attachmentSelection.resetAttachments()
        }
        return sent
      }

      const prepared = buildSendPayload(payloadMessage)
      if (!prepared) {
        reportSendBlocked('Wework default team is not configured', {
          hasDefaultTeam: Boolean(state.defaultTeam),
        })
        return false
      }
      if (prepared.activeDeviceId) {
        const activeDevice = findWorkbenchDevice(state.devices, prepared.activeDeviceId)
        if (!isWorkbenchDeviceOnline(activeDevice)) {
          const deviceName = getWorkbenchDeviceDisplayName(activeDevice, prepared.activeDeviceId)
          const status = activeDevice
            ? (DEVICE_STATUS_LABELS[activeDevice.status] ?? activeDevice.status)
            : '不可用'
          reportSendBlocked(`${deviceName} ${status}，恢复在线后可继续对话`, {
            activeDeviceId: prepared.activeDeviceId,
            deviceStatus: activeDevice?.status ?? null,
          })
          return false
        }
        if (activeDevice && isDeviceBelowWeWorkVersion(activeDevice)) {
          const deviceName = getWorkbenchDeviceDisplayName(activeDevice, prepared.activeDeviceId)
          reportSendBlocked(
            `${deviceName} 版本低于 ${WEWORK_MIN_EXECUTOR_VERSION}，升级后可继续对话`,
            {
              activeDeviceId: prepared.activeDeviceId,
              executorVersion: activeDevice.executor_version ?? null,
            }
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
            }
          )
          return false
        }
      }

      const sent = await sendPreparedRuntimeMessage(
        message,
        prepared.payload,
        prepared.activeDeviceId,
        {
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
            modelSelection.selectedModel ?? resolveAutomaticModel(modelSelection.models)
          const response = await executorClient.runtime.sendRuntimeMessage({
            address: state.currentRuntimeTask,
            message: previousUserMessage.content,
            ...selectedModelExecutionFields(
              runtimeSelectedModel,
              modelSelection.selectedModelOptions
            ),
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
    ]
  )

  const loadTurnFileChangesDiff = useCallback(
    async (turnId: number, messagesOverride?: WorkbenchMessage[]) => {
      const messageSource = messagesOverride ?? []
      const runtimeFileChanges = state.currentRuntimeTask
        ? findFileChangesByTurnId(messageSource, turnId)
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
      const response = await loadDiff(turnId)
      return response.diff
    },
    [executorClient, services.taskApi, state.currentRuntimeTask]
  )

  const revertTurnFileChanges = useCallback(
    async (
      turnId: number,
      messagesOverride?: WorkbenchMessage[]
    ): Promise<TurnFileChangesSummary> => {
      const messageSource = messagesOverride ?? []
      const runtimeFileChanges = state.currentRuntimeTask
        ? findFileChangesByTurnId(messageSource, turnId)
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
        const response = await revert(turnId)
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

  const pauseCurrentResponse = useCallback(
    async (messagesOverride?: WorkbenchMessage[]) => {
      const activeMessage = findActiveAssistantMessage(messagesOverride ?? [])
      if (!activeMessage || !state.currentRuntimeTask) return

      const ack = await executorClient.runtime.cancelRuntimeTask(state.currentRuntimeTask)
      if (!ack.accepted) {
        dispatch({
          type: 'error_set',
          error: normalizeGuidanceError(ack.error ?? '取消当前回复失败'),
        })
        return
      }
      await refreshWorkLists()
    },
    [dispatch, executorClient, refreshWorkLists, state.currentRuntimeTask]
  )

  return {
    sendRuntimePaneMessage,
    cancelRuntimePaneTask,
    sendCurrentInput,
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
    localTasks: [],
  }
}

function buildOptimisticRuntimeTask({
  localTaskId,
  workspacePath,
  title,
  runtime,
}: {
  localTaskId: string
  workspacePath: string
  title: string
  runtime: LocalTaskSummary['runtime']
}): LocalTaskSummary {
  const now = new Date().toISOString()
  return {
    localTaskId,
    workspacePath,
    title,
    runtime,
    createdAt: now,
    updatedAt: now,
    running: true,
    status: 'creating',
  }
}

function runtimeAddressLog(address: RuntimeTaskAddress): Record<string, unknown> {
  return {
    deviceId: address.deviceId,
    localTaskId: address.localTaskId,
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

function isRuntimeDebugEnabled(): boolean {
  return globalThis.localStorage?.getItem('wework:debug-runtime') === '1'
}
