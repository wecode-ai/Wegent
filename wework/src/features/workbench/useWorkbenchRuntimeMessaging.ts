import { useCallback } from 'react'
import type { Dispatch } from 'react'
import { ApiError } from '@/api/http'
import type { ExecutorClient } from '@/api/executorAccess'
import i18n from '@/i18n'
import { appendCodeCommentContexts } from '@/lib/code-comment-context'
import { getPreferredStandaloneDeviceId } from '@/lib/device-selection'
import {
  WEWORK_MIN_EXECUTOR_VERSION,
  isDeviceBelowWeWorkVersion,
  isWeWorkCompatibleDevice,
} from '@/lib/device-capabilities'
import { localRuntimeAttachments, remoteAttachmentIds } from '@/lib/runtime-attachments'
import { normalizeRuntimeWorkspacePath, runtimeProjectUiId } from '@/lib/runtime-project'
import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'
import {
  resolveRuntimeTaskWorkspaceBinding,
  withoutRuntimeTaskWorkspaceBinding,
} from '@/lib/runtime-task-workspace-binding'
import {
  probeProjectWorktreeAvailability,
  worktreeWorkspaceDeviceId,
} from '@/lib/worktree-availability'
import { notifyMainRuntimeWorkChanged } from '@/desktop/runtimeWorkSync'
import type { AppPreferences } from '@/desktop/appPreferences'
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
  RuntimeWorkListResponse,
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
  buildRuntimeTaskTitle,
  createRuntimeTaskId,
  createRuntimeTaskIdFromSeed,
  findProjectDeviceWorkspace,
  findRuntimeTask,
  getCommandStdoutObject,
  isRecord,
  isSameRuntimeTaskIdentity,
  mergeRuntimeTaskHandles,
} from './workbenchRuntimeHelpers'
import type { WorkbenchRuntimeTasks } from './useWorkbenchRuntimeTasks'
import {
  applyRuntimeConversationAction,
  removeRuntimeConversationTurn,
} from './runtimeConversationCache'
import { findFileChangesBySubtaskId } from './runtimePaneMessages'
import { isRuntimeTaskBusyError } from './runtimePaneStatus'
import type { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle'
import {
  inferRuntimeName,
  resolveAutomaticModel,
  selectedModelExecutionFields,
} from './runtimeModelSelection'
export function buildRuntimeTaskCreateHandle(
  modelSelection: ModelSelectionConfig | null,
  request: Pick<RuntimeTaskCreateRequest, 'cloudProjectId' | 'origin'>
): Record<string, unknown> | undefined {
  if (!modelSelection && !request.cloudProjectId && !request.origin) return undefined
  return {
    ...(modelSelection ? { modelSelection } : {}),
    ...(request.cloudProjectId ? { cloudProjectId: request.cloudProjectId } : {}),
    ...(request.origin ? { origin: request.origin } : {}),
  }
}

export interface PreparedRuntimeTaskIntent {
  projectId: number | null
  message: string
  title?: string
  modelId?: string
  modelType?: ModelType | null
  modelOptions?: ModelOptions
  additionalSkills?: SkillRef[]
  attachmentIds?: number[]
  attachments?: Attachment[]
  execution?: RuntimeTaskCreateRequest['execution']
}

import { getDesktopE2ERuntimeConfig } from '@/e2e/runtime-config'
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

function runtimeCreateMessage(intent: PreparedRuntimeTaskIntent): string {
  const message = intent.message.trim()
  if (message) return intent.message
  const filenames = (intent.attachments ?? [])
    .map(attachment => attachment.filename.trim())
    .filter(Boolean)
  return filenames.length > 0
    ? `Attached files:\n${filenames.map(name => `- ${name}`).join('\n')}`
    : ''
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

export function runtimeExecutablePathForTarget({
  executablePath,
  targetDevice,
  workspaceSource,
}: {
  executablePath?: string
  targetDevice: WorkbenchState['devices'][number] | null
  workspaceSource?: RuntimeDeviceWorkspace['workspaceSource']
}): string | undefined {
  if (!executablePath) return undefined
  if (
    workspaceSource === 'remote' ||
    targetDevice?.device_type === 'cloud' ||
    targetDevice?.device_type === 'remote'
  ) {
    return undefined
  }
  return executablePath
}

interface RuntimeMessagingAttachmentSelection {
  attachments: Attachment[]
  resetAttachments: () => void
}

interface RuntimeMessagingModelSelection {
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  selectedModelOptions: ModelOptions
  isSelectionReady?: boolean
  isConfiguredModelUnavailable?: boolean
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

export function resolveTemporaryChatSource(
  source: RuntimeTaskAddress | null | undefined,
  runtimeWork: WorkbenchState['runtimeWork']
): RuntimeTaskAddress | null {
  if (!source) return null
  const task = findRuntimeTask(runtimeWork, source)
  if (!task) return source
  const runtimeHandle = mergeRuntimeTaskHandles(source.runtimeHandle, task.runtimeHandle)
  return {
    ...source,
    runtime: task.runtime,
    workspacePath: task.workspacePath || source.workspacePath,
    ...(task.threadId ? { threadId: task.threadId } : {}),
    ...(runtimeHandle ? { runtimeHandle } : {}),
  }
}

export function resolveRuntimeTaskCreateWorkspacePath({
  sourcePath,
  responsePath,
  requestedManagedWorkspace,
}: {
  sourcePath?: string
  responsePath?: string
  requestedManagedWorkspace: boolean
}): string | undefined {
  const normalizedResponsePath = responsePath?.trim()
  if (!requestedManagedWorkspace) return normalizedResponsePath || sourcePath
  if (!normalizedResponsePath) {
    throw new Error('Managed workspace creation did not return a planned workspace path')
  }
  if (
    sourcePath &&
    normalizeRuntimeWorkspacePath(normalizedResponsePath) ===
      normalizeRuntimeWorkspacePath(sourcePath)
  ) {
    throw new Error('Managed workspace creation returned the base workspace path')
  }
  return normalizedResponsePath
}

export async function loadTemporaryChatSource(
  source: RuntimeTaskAddress | null | undefined,
  runtimeWork: WorkbenchState['runtimeWork'],
  listRuntimeWork: () => Promise<RuntimeWorkListResponse>
): Promise<RuntimeTaskAddress | null> {
  const cachedSource = resolveTemporaryChatSource(source, runtimeWork)
  if (!cachedSource || runtimeThreadId(cachedSource)) return cachedSource
  return resolveTemporaryChatSource(cachedSource, await listRuntimeWork())
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
  return titleModelForGeneration(preferences, models, executionModel)
}

export function titleModelForGeneration(
  preferences: Pick<AppPreferences, 'friendlyTaskTitleModel'> | undefined,
  models: UnifiedModel[],
  executionModel: Pick<RuntimeSendRequest, 'modelId' | 'modelType' | 'modelOptions'>
): RuntimeTaskFriendlyTitleConfig | null {
  const configuredModel = preferences?.friendlyTaskTitleModel
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

  const blockRuntimeSendForUnavailableModel = useCallback(
    (address: RuntimeTaskAddress, options?: RuntimePaneActionOptions): boolean => {
      const isCurrentTask =
        state.currentRuntimeTask && isSameRuntimeTaskIdentity(state.currentRuntimeTask, address)
      if (
        !isCurrentTask ||
        (modelSelection.isSelectionReady !== false &&
          modelSelection.isConfiguredModelUnavailable !== true)
      ) {
        return false
      }
      reportSendBlocked(
        i18n.t('workbench.harness_model_required', '请选择可用的 Wework 模型'),
        undefined,
        options
      )
      return true
    },
    [
      modelSelection.isConfiguredModelUnavailable,
      modelSelection.isSelectionReady,
      reportSendBlocked,
      state.currentRuntimeTask,
    ]
  )

  const sendRuntimePaneMessage = useCallback(
    async (request: RuntimeSendRequest, options?: RuntimePaneActionOptions): Promise<boolean> => {
      if (blockRuntimeSendForUnavailableModel(request.address, options)) return false

      let sendRequested = false
      const optimisticUserMessage = options?.optimisticUserMessage
      const outboundRequestWithClientId = optimisticUserMessage
        ? {
            ...request,
            clientUserMessageId: optimisticUserMessage.id,
          }
        : request
      if (optimisticUserMessage) {
        applyRuntimeConversationAction(request.address, {
          type: 'user_added',
          message: optimisticUserMessage,
        })
      }
      try {
        const outboundRequest = await prepareRuntimeSendRequest(outboundRequestWithClientId)
        if (!options?.silentBusyRetry) {
          lifecycleStore.sendRequested(outboundRequest.address)
          sendRequested = true
        }
        const response = await executorClient.runtime.sendRuntimeMessage(outboundRequest)
        if (!response.accepted) {
          throw new Error(response.error || '发送失败')
        }
        if (options?.silentBusyRetry) {
          lifecycleStore.sendRequested(outboundRequest.address)
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
        if (optimisticUserMessage) {
          removeRuntimeConversationTurn(request.address, {
            clientUserMessageId: optimisticUserMessage.id,
          })
        }
        const errorMessage = error instanceof Error ? error.message : '发送失败'
        const blockedByActiveTurn = isRuntimeTaskBusyError(errorMessage)
        if (sendRequested) {
          if (blockedByActiveTurn) {
            lifecycleStore.sendBlockedByActiveTurn(request.address)
          } else {
            lifecycleStore.sendRejected(request.address)
          }
        }
        if (blockedByActiveTurn && !options?.silentBusyRetry) {
          try {
            await refreshWorkLists()
          } catch (refreshError) {
            console.warn('[Wework] Runtime busy-state refresh failed', {
              taskId: request.address.taskId,
              error: refreshError instanceof Error ? refreshError.message : String(refreshError),
            })
          }
        }
        if (!options?.silentBusyRetry) {
          console.warn('[Wework] Runtime send failed', {
            taskId: request.address.taskId,
            deviceId: request.address.deviceId,
            workspacePath: request.address.workspacePath ?? null,
            addressKeys: Object.keys(request.address as unknown as Record<string, unknown>).sort(),
            error: errorMessage,
          })
        }
        reportError(runtimeSendError(error, '发送失败'), options)
        return false
      }
    },
    [
      blockRuntimeSendForUnavailableModel,
      executorClient,
      lifecycleStore,
      prepareRuntimeSendRequest,
      refreshWorkLists,
      reportError,
    ]
  )

  const interruptAndSendRuntimePaneMessage = useCallback(
    async (request: RuntimeSendRequest, options?: RuntimePaneActionOptions): Promise<boolean> => {
      if (blockRuntimeSendForUnavailableModel(request.address, options)) return false

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
    [
      blockRuntimeSendForUnavailableModel,
      executorClient,
      lifecycleStore,
      prepareRuntimeSendRequest,
      refreshWorkLists,
      reportError,
    ]
  )

  const editLastUserMessage = useCallback(
    async (request: RuntimeRollbackRequest): Promise<boolean> => {
      if (blockRuntimeSendForUnavailableModel(request.address)) return false

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
    [
      blockRuntimeSendForUnavailableModel,
      dispatch,
      executorClient,
      lifecycleStore,
      prepareRuntimeSendRequest,
      refreshWorkLists,
    ]
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
      const subtaskId = `${address.taskId}-context-compact`
      const blockId = `context-compaction-${Date.now()}`
      const createdAt = Date.now()
      lifecycleStore.sendRequested(address)
      applyRuntimeConversationAction(address, {
        type: 'assistant_started',
        taskId: address.taskId,
        subtaskId,
      })
      applyRuntimeConversationAction(address, {
        type: 'block_created',
        subtaskId,
        block: {
          id: blockId,
          type: 'tool',
          toolName: 'context_compaction',
          status: 'pending',
          subtaskId,
          createdAt,
        },
      })
      try {
        const response = await executorClient.runtime.compactRuntimeTask({ address })
        if (!response.accepted) {
          throw new Error(response.error || '压缩上下文失败')
        }
        lifecycleStore.sendAccepted(address)
        applyRuntimeConversationAction(address, {
          type: 'block_updated',
          subtaskId,
          blockId,
          updates: {
            status: 'done',
            completedAt: Date.now(),
          },
        })
        applyRuntimeConversationAction(address, {
          type: 'assistant_done',
          subtaskId,
        })
        lifecycleStore.executorSettled(address)
        try {
          await refreshWorkLists()
        } catch (error) {
          console.warn('[Wework] Runtime compact accepted but work list refresh failed', {
            taskId: response.taskId ?? address.taskId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : '压缩上下文失败'
        applyRuntimeConversationAction(address, {
          type: 'block_updated',
          subtaskId,
          blockId,
          updates: {
            status: 'error',
            completedAt: Date.now(),
          },
        })
        applyRuntimeConversationAction(address, {
          type: 'assistant_error',
          subtaskId,
          error: message,
        })
        lifecycleStore.sendRejected(address)
        console.warn('[Wework] Runtime compact failed', {
          taskId: address.taskId,
          deviceId: address.deviceId,
          workspacePath: address.workspacePath ?? null,
          error: message,
        })
        reportError(message, options)
        return false
      }
    },
    [executorClient, lifecycleStore, refreshWorkLists, reportError]
  )

  const cancelRuntimePaneTask = useCallback(
    async (address: RuntimeTaskAddress, options?: RuntimePaneActionOptions): Promise<boolean> => {
      try {
        const ack = await executorClient.runtime.cancelRuntimeTask(address)
        if (!ack.accepted) {
          reportError(normalizeGuidanceError(ack.error ?? '取消当前回复失败'), options)
          return false
        }
        lifecycleStore.stopRequested(address)
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
    [executorClient, lifecycleStore, refreshWorkLists, reportError]
  )

  const buildSendPayload = useCallback(
    (
      message: string,
      sourceAttachments?: Attachment[],
      projectOverride?: ProjectWithTasks | null,
      includeSelectedSkills = !isOptionsLocked,
      selectedSkillsOverride?: SkillRef[],
      deviceOverride?: string | null,
      deviceWorkspaceIdOverride?: number | null
    ): { intent: PreparedRuntimeTaskIntent; activeDeviceId?: string } => {
      const activeProject = projectOverride === undefined ? state.currentProject : projectOverride
      const selectedProjectWorkspace = findProjectDeviceWorkspace(
        state.runtimeWork,
        activeProject?.id,
        deviceWorkspaceIdOverride === undefined
          ? state.selectedDeviceWorkspaceId
          : deviceWorkspaceIdOverride
      )
      const selectedProjectDeviceId = worktreeWorkspaceDeviceId(selectedProjectWorkspace)
      const activeDeviceId =
        deviceOverride ||
        (activeProject && selectedProjectWorkspace
          ? (selectedProjectDeviceId ?? selectedProjectWorkspace.deviceId)
          : getActiveWorkbenchDeviceId({
              currentProject: activeProject,
              standaloneDeviceId: getPreferredStandaloneDeviceId(
                state.devices,
                state.standaloneDeviceId
              ),
            }))

      const intent: PreparedRuntimeTaskIntent = {
        projectId: activeProject?.id ?? null,
        message,
      }
      const selectedModel =
        modelSelection.getSelectedModel?.() ??
        modelSelection.selectedModel ??
        resolveAutomaticModel(modelSelection.models)
      const selectedModelOptions =
        modelSelection.getSelectedModelOptions?.() ?? modelSelection.selectedModelOptions

      if (activeProject && projectExecutionMode !== 'current_workspace') {
        const branch = projectWorktreeBranch?.trim()
        intent.execution = {
          workspace: {
            source: projectExecutionMode,
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
        intent.modelId = executionModel.modelId
        intent.modelType = executionModel.modelType
      }
      if (executionModel.modelOptions && Object.keys(executionModel.modelOptions).length > 0) {
        intent.modelOptions = executionModel.modelOptions
      }

      const selectedSkills = selectedSkillsOverride ?? skillSelection.selectedSkills
      if (
        (selectedSkillsOverride !== undefined || includeSelectedSkills) &&
        selectedSkills.length > 0
      ) {
        intent.additionalSkills = selectedSkills
      }

      const payloadAttachments = sourceAttachments ?? attachmentSelection.attachments
      if (payloadAttachments.length > 0) {
        const attachmentIds = remoteAttachmentIds(payloadAttachments)
        const localAttachments = localRuntimeAttachments(payloadAttachments)
        if (attachmentIds.length > 0) {
          intent.attachmentIds = attachmentIds
        }
        if (localAttachments.length > 0) {
          intent.attachments = localAttachments
        }
        if (!message) {
          intent.title = EMPTY_MESSAGE_TASK_TITLE
        }
      }

      return { intent, activeDeviceId }
    },
    [
      attachmentSelection.attachments,
      isOptionsLocked,
      modelSelection,
      projectExecutionMode,
      projectWorktreeBranch,
      skillSelection.selectedSkills,
      state.currentProject,
      state.devices,
      state.runtimeWork,
      state.selectedDeviceWorkspaceId,
      state.standaloneDeviceId,
    ]
  )

  const sendPreparedRuntimeMessage = useCallback(
    async (
      displayMessage: string,
      intent: PreparedRuntimeTaskIntent,
      activeDeviceId?: string,
      options?: Pick<
        SendCurrentInputOptions,
        | 'clientUserMessageId'
        | 'optimisticUserMessage'
        | 'initialGoal'
        | 'initialSupervisor'
        | 'onError'
        | 'onRuntimeTaskOptimisticOpen'
        | 'prepareRuntimeTask'
        | 'additionalContext'
        | 'runtime'
        | 'runtimeExecutablePath'
        | 'runtimePermissionMode'
        | 'modelSelection'
      > & {
        collaborationMode?: 'default' | 'plan'
        deliveryId?: string
        cloudProjectId?: string
        origin?: RuntimeTaskCreateRequest['origin']
        deviceWorkspaceId?: number | null
        ephemeral?: boolean
        openInMainPane?: boolean
        refreshWorkListsOnResolve?: boolean
        sideSource?: RuntimeTaskAddress | null
        preserveAttachments?: boolean
        launchStartedAt?: number
        taskCreateRequest?: RuntimeTaskCreateRequest | null
      }
    ): Promise<RuntimeTaskAddress | false> => {
      const launchStartedAt = options?.launchStartedAt ?? runtimeLaunchNowMs()
      const sourceBlankChatKey = state.currentRuntimeTask ? null : state.standaloneChatKey
      const projectId = intent.projectId
      const requestedManagedWorkspace = Boolean(intent.execution?.workspace)
      const hasOverrideSelection = Boolean(
        options && Object.prototype.hasOwnProperty.call(options, 'modelSelection')
      )
      const overrideSelection = options?.modelSelection ?? null
      const selectedModel = hasOverrideSelection
        ? overrideSelection
          ? (modelSelection.models.find(
              model =>
                model.name === overrideSelection.modelName &&
                (!overrideSelection.modelType || model.type === overrideSelection.modelType)
            ) ?? null)
          : null
        : (modelSelection.getSelectedModel?.() ??
          modelSelection.selectedModel ??
          resolveAutomaticModel(modelSelection.models))
      const selectedModelOptions = hasOverrideSelection
        ? (overrideSelection?.options ?? {})
        : (modelSelection.getSelectedModelOptions?.() ?? modelSelection.selectedModelOptions)
      const executionModel = options?.taskCreateRequest
        ? {
            modelId: options.taskCreateRequest.modelId,
            modelType: options.taskCreateRequest.modelType,
            modelOptions: options.taskCreateRequest.modelOptions,
          }
        : selectedModelExecutionFields(selectedModel, selectedModelOptions)
      const runtime = options?.runtime ?? inferRuntimeName(selectedModel)
      const friendlyTitle =
        runtime === 'codex'
          ? friendlyTitleForTask(
              preferences,
              modelSelection.models,
              executionModel,
              options?.ephemeral
            )
          : null
      const taskSeed = createRuntimeTaskId(runtime)
      const taskId = createRuntimeTaskIdFromSeed(taskSeed)
      const clientUserMessageId = options?.optimisticUserMessage?.id ?? options?.clientUserMessageId
      logRuntimeTaskLaunchTiming('prepared-send-entered', launchStartedAt, {
        taskId,
        clientUserMessageId: clientUserMessageId ?? null,
        projectId,
        runtime,
      })
      const selectedProjectWorkspace = findProjectDeviceWorkspace(
        state.runtimeWork,
        projectId,
        options?.deviceWorkspaceId === undefined
          ? state.selectedDeviceWorkspaceId
          : options.deviceWorkspaceId
      )
      const selectedProjectDeviceId = worktreeWorkspaceDeviceId(selectedProjectWorkspace)
      const selectedRuntimeProject = projectId
        ? state.runtimeWork?.projects.find(item => runtimeProjectUiId(item.project) === projectId)
            ?.project
        : null
      let runtimeTaskTarget: Pick<
        RuntimeTaskCreateRequest,
        | 'projectId'
        | 'deviceWorkspaceId'
        | 'deviceId'
        | 'workspacePath'
        | 'standaloneChatWorkspace'
        | 'runtimeProjectKey'
        | 'runtimeProjectName'
        | 'runtimeWorkspaceRoots'
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
        optimisticDeviceId = selectedProjectDeviceId ?? selectedProjectWorkspace.deviceId
        const workspaceBinding = resolveRuntimeTaskWorkspaceBinding({
          runtimeWork: state.runtimeWork,
          projectUiId: projectId,
          deviceWorkspaceId:
            options?.deviceWorkspaceId === undefined
              ? state.selectedDeviceWorkspaceId
              : options.deviceWorkspaceId,
        })
        if (!workspaceBinding) {
          reportSendBlocked('无法解析任务运行项目', undefined, options)
          return false
        }
        runtimeTaskTarget = {
          ...workspaceBinding,
          deviceId: optimisticDeviceId,
        }
      } else {
        if (!activeDeviceId) {
          reportSendBlocked('请选择设备后再发送', undefined, options)
          return false
        }
        optimisticDeviceId = activeDeviceId
        runtimeTaskTarget = {
          deviceId: activeDeviceId,
          standaloneChatWorkspace: true,
        }
      }

      if (requestedManagedWorkspace) {
        const worktreeProject =
          state.projects.find(project => project.id === projectId) ??
          (state.currentProject?.id === projectId ? state.currentProject : null)
        const worktreeDeviceId = worktreeWorkspaceDeviceId(selectedProjectWorkspace)
        const worktreeDevice = findWorkbenchDevice(state.devices, worktreeDeviceId)
        const runtimeWorkApi = services.runtimeWorkApi
        if (!runtimeWorkApi || !worktreeProject) {
          reportSendBlocked(
            i18n.t('workbench.worktree_unavailable_preflight_failed'),
            { worktreeDeviceId, reason: 'runtime_api_unavailable' },
            options
          )
          return false
        }
        const availability = await probeProjectWorktreeAvailability({
          api: runtimeWorkApi,
          project: worktreeProject,
          workspace: selectedProjectWorkspace,
          device: worktreeDevice,
          ref: intent.execution?.workspace?.branch ?? projectWorktreeBranch,
        })
        if (!availability.available) {
          reportSendBlocked(
            i18n.t(`workbench.worktree_unavailable_${availability.reason}`),
            {
              worktreeDeviceId,
              reason: availability.reason,
              sourcePath: availability.sourcePath,
            },
            options
          )
          return false
        }
      }

      logRuntimeTaskCreateStage('workbench-model-prepare-started', {
        taskId,
        deviceId: optimisticDeviceId,
        modelId: executionModel.modelId ?? null,
      })
      try {
        const prepared = await executorClient.runtime.prepareRuntimeModel({
          deviceId: optimisticDeviceId,
          modelId: executionModel.modelId,
        })
        if (!prepared) {
          reportError(i18n.t('workbench.cloud_model_catalog_sync_cancelled'), options)
          return false
        }
        const supervisorModelId = options?.initialSupervisor?.modelSelection?.modelName
        if (supervisorModelId) {
          const supervisorPrepared = await executorClient.runtime.prepareRuntimeModel({
            deviceId: optimisticDeviceId,
            modelId: supervisorModelId,
          })
          if (!supervisorPrepared) {
            reportError(i18n.t('workbench.cloud_model_catalog_sync_cancelled'), options)
            return false
          }
        }
        logRuntimeTaskCreateStage('workbench-model-prepare-resolved', {
          taskId,
          deviceId: optimisticDeviceId,
          modelId: executionModel.modelId ?? null,
          supervisorModelId: supervisorModelId ?? null,
        })
      } catch (error) {
        logRuntimeTaskCreateStage('workbench-model-prepare-failed', {
          taskId,
          deviceId: optimisticDeviceId,
          error: runtimeLaunchErrorName(error),
        })
        reportError(runtimeSendError(error, '发送失败'), options)
        return false
      }

      let preparedAttachments: RuntimeAttachmentTransport
      try {
        preparedAttachments = await prepareRuntimeAttachmentsForDevice(
          optimisticDeviceId,
          state.devices,
          intent.attachmentIds,
          intent.attachments,
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

      const targetDevice = findWorkbenchDevice(state.devices, optimisticDeviceId)
      const runtimeExecutablePath = runtimeExecutablePathForTarget({
        executablePath: options?.runtimeExecutablePath,
        targetDevice,
        workspaceSource:
          selectedProjectDeviceId === optimisticDeviceId
            ? selectedProjectWorkspace?.workspaceSource
            : undefined,
      })
      const createRequest: RuntimeTaskCreateRequest = {
        schemaVersion: 2,
        ...(options?.taskCreateRequest
          ? withoutRuntimeTaskWorkspaceBinding(options.taskCreateRequest)
          : {}),
        ...runtimeTaskTarget,
        taskId,
        runtime,
        ...(runtimeExecutablePath ? { runtimeExecutablePath } : {}),
        ...(options?.runtimePermissionMode
          ? { runtimePermissionMode: options.runtimePermissionMode }
          : {}),
        message: runtimeCreateMessage(intent),
        ...(clientUserMessageId ? { clientUserMessageId } : {}),
        title: buildRuntimeTaskTitle(displayMessage, intent.title),
        modelId: executionModel.modelId,
        modelType: executionModel.modelType ?? null,
        modelOptions: {
          ...(executionModel.modelOptions ?? {}),
          ...(options && 'collaborationMode' in options && options.collaborationMode
            ? { collaborationMode: options.collaborationMode }
            : {}),
        },
        modelSelection:
          selectedModel && executionModel.modelId
            ? {
                modelName: executionModel.modelId,
                modelType: executionModel.modelType ?? selectedModel.type,
                options: executionModel.modelOptions ?? {},
              }
            : (options?.modelSelection ?? null),
        ...(friendlyTitle ? { friendlyTitle } : {}),
        additionalSkills: intent.additionalSkills ?? [],
        attachmentIds: preparedAttachments.attachmentIds,
        attachments: preparedAttachments.attachments,
        execution: intent.execution,
        ...(selectedRuntimeProject
          ? {
              ...(selectedRuntimeProject.aiSettings?.instructions?.trim()
                ? { projectInstructions: selectedRuntimeProject.aiSettings.instructions.trim() }
                : {}),
              projectPlugins: selectedRuntimeProject.aiSettings?.plugins ?? [],
            }
          : {}),
        ...(options?.ephemeral ? { ephemeral: true } : {}),
        ...(options?.sideSource ? { sideSource: options.sideSource } : {}),
        ...(options?.initialGoal ? { initialGoal: options.initialGoal } : {}),
        ...(options?.initialSupervisor ? { initialSupervisor: options.initialSupervisor } : {}),
        ...(options?.deliveryId ? { deliveryId: options.deliveryId } : {}),
        ...(options?.cloudProjectId ? { cloudProjectId: options.cloudProjectId } : {}),
        ...(options?.origin ? { origin: options.origin } : {}),
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
      const createRuntimeHandle = buildRuntimeTaskCreateHandle(createModelSelection, createRequest)
      const sourceWorkspacePath =
        'workspacePath' in runtimeTaskTarget ? runtimeTaskTarget.workspacePath : undefined
      const optimisticAddress: RuntimeTaskAddress = {
        deviceId: optimisticDeviceId,
        taskId,
        runtime,
        workspacePath: requestedManagedWorkspace ? undefined : sourceWorkspacePath,
        ...(createRuntimeHandle ? { runtimeHandle: createRuntimeHandle } : {}),
      }
      const seedOptimisticUserMessage = (address: RuntimeTaskAddress) => {
        if (!options?.optimisticUserMessage) {
          return
        }
        applyRuntimeConversationAction(address, {
          type: 'user_added',
          message: options.optimisticUserMessage,
        })
      }
      modelSelection.setSelectionForScope?.(
        getRuntimeTaskChatScopeKey(optimisticAddress),
        selectedModel,
        selectedModelOptions
      )
      const optimisticWorkspacePath = requestedManagedWorkspace
        ? undefined
        : (sourceWorkspacePath ?? selectedProjectWorkspace?.workspacePath)
      const optimisticWorkspace =
        optimisticWorkspacePath && optimisticDeviceId
          ? buildOptimisticRuntimeWorkspace({
              baseWorkspace: selectedProjectWorkspace,
              devices: state.devices,
              deviceId: optimisticDeviceId,
              workspacePath: optimisticWorkspacePath,
              projectId,
              workspaceKind: undefined,
            })
          : null
      const runtimeProject = projectId
        ? (state.projects.find(project => project.id === projectId) ?? state.currentProject)
        : null
      let rollbackPreparedRuntimeTask: (() => void | Promise<void>) | void
      try {
        rollbackPreparedRuntimeTask = await options?.prepareRuntimeTask?.(optimisticAddress)
      } catch (error) {
        const message = error instanceof Error ? error.message : '任务绑定失败'
        reportError(message, options)
        return false
      }

      debugRuntimeCreateFlow('create-optimistic-open', {
        taskId,
        runtime,
        projectId,
        optimisticAddress: runtimeAddressLog(optimisticAddress),
        hasSelectedProjectWorkspace: Boolean(selectedProjectWorkspace),
        optimisticWorkspacePath: optimisticWorkspacePath ?? null,
      })
      lifecycleStore.sendRequested(optimisticAddress, {
        ...(requestedManagedWorkspace
          ? { workspaceCreationKind: intent.execution?.workspace?.source }
          : {}),
      })
      if (options?.initialGoal) {
        lifecycleStore.goalStatusReceived(optimisticAddress, options.initialGoal.status ?? 'active')
      }
      logRuntimeTaskLaunchTiming('runtime-create-started', launchStartedAt, {
        taskId,
        clientUserMessageId: clientUserMessageId ?? null,
        deviceId: optimisticAddress.deviceId,
      })
      // Start the primary request before optimistic navigation mounts task readers.
      // Presentation work must never leave a visible pending task without a runtime request.
      const createResponsePromise = (async () => {
        const worktreeCreationDelayMs = Number(
          getDesktopE2ERuntimeConfig().worktreeCreationDelayMs ??
            import.meta.env.VITE_WEWORK_E2E_WORKTREE_CREATION_DELAY_MS ??
            0
        )
        if (
          intent.execution?.workspace &&
          Number.isFinite(worktreeCreationDelayMs) &&
          worktreeCreationDelayMs > 0
        ) {
          await new Promise(resolve => window.setTimeout(resolve, worktreeCreationDelayMs))
        }
        logRuntimeTaskCreateStage('workbench-runtime-create-dispatched', {
          taskId,
          deviceId: optimisticAddress.deviceId,
          runtime,
        })
        return executorClient.runtime.createRuntimeTask(createRequest)
      })()
      void createResponsePromise.catch(() => undefined)
      logRuntimeTaskLaunchTiming('optimistic-open-started', launchStartedAt, {
        taskId,
        clientUserMessageId: clientUserMessageId ?? null,
        deviceId: optimisticAddress.deviceId,
      })
      seedOptimisticUserMessage(optimisticAddress)
      await options?.onRuntimeTaskOptimisticOpen?.(optimisticAddress)
      if (options?.openInMainPane !== false) {
        runtimeTasks.openRuntimeTaskView(optimisticAddress, runtimeProject, { navigate: true })
      }
      logRuntimeTaskLaunchTiming('optimistic-open-dispatched', launchStartedAt, {
        taskId,
        clientUserMessageId: clientUserMessageId ?? null,
        deviceId: optimisticAddress.deviceId,
        openedInMainPane: options?.openInMainPane !== false,
      })
      logRuntimeTaskLaunchPaintTiming(launchStartedAt, {
        taskId,
        clientUserMessageId: clientUserMessageId ?? null,
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
            title: createRequest.title ?? buildRuntimeTaskTitle(displayMessage, intent.title),
            runtime,
            workspaceKind: undefined,
            modelSelection: createModelSelection,
          }),
        })
      }
      if (!options?.preserveAttachments) {
        attachmentSelection.resetAttachments()
      }

      try {
        const response = await createResponsePromise
        logRuntimeTaskLaunchTiming('runtime-create-resolved', launchStartedAt, {
          taskId,
          clientUserMessageId: clientUserMessageId ?? null,
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
        const resolvedCreateWorkspacePath = resolveRuntimeTaskCreateWorkspacePath({
          sourcePath: sourceWorkspacePath,
          responsePath: response.workspacePath,
          requestedManagedWorkspace,
        })
        const address: RuntimeTaskAddress = {
          deviceId: response.deviceId || optimisticAddress.deviceId,
          taskId: response.taskId || optimisticAddress.taskId,
          runtime: response.runtime || optimisticAddress.runtime,
          workspacePath: resolvedCreateWorkspacePath,
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
              workspaceKind: intent.execution?.workspace?.source,
            }),
            task: buildOptimisticRuntimeTask({
              taskId: address.taskId,
              workspacePath: resolvedWorkspacePath,
              title: createRequest.title ?? buildRuntimeTaskTitle(displayMessage, intent.title),
              runtime,
              status: response.status ?? 'running',
              queuePosition: response.queuePosition,
              workspaceKind: intent.execution?.workspace?.source,
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
          debugRuntimeCreateFlow('create-final-open', {
            taskId: address.taskId,
            runtime,
            previousAddress: runtimeAddressLog(optimisticAddress),
            finalAddress: runtimeAddressLog(address),
          })
          seedOptimisticUserMessage(address)
          await options?.onRuntimeTaskOptimisticOpen?.(address, {
            previousAddress: optimisticAddress,
          })
        }
        if (options?.openInMainPane !== false && optimisticTaskStillSelected) {
          runtimeTasks.openRuntimeTaskView(address, runtimeProject, {
            markOpened: !resolvedSameIdentity,
            navigate: !resolvedSameIdentity,
          })
        }
        if (response.status === 'queued') {
          lifecycleStore.syncRuntimeTask(address, {
            taskId: address.taskId,
            workspacePath: resolvedWorkspacePath ?? '',
            title: createRequest.title ?? buildRuntimeTaskTitle(displayMessage, intent.title),
            runtime,
            running: false,
            status: 'queued',
            queuePosition: response.queuePosition,
            optimistic: true,
          })
        } else {
          lifecycleStore.sendAccepted(address)
        }
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
          try {
            await refreshWorkLists()
          } catch (error) {
            console.warn('[Wework] Runtime task accepted but work-list refresh failed', {
              deviceId: address.deviceId,
              taskId: address.taskId,
              error,
            })
          }
        }
        if (options?.openInMainPane !== false && sourceBlankChatKey !== null) {
          dispatch({
            type: 'blank_chat_committed',
            standaloneChatKey: sourceBlankChatKey,
          })
        }
        return address
      } catch (error) {
        logRuntimeTaskLaunchTiming('runtime-create-failed', launchStartedAt, {
          taskId,
          clientUserMessageId: clientUserMessageId ?? null,
          deviceId: optimisticAddress.deviceId,
          error: runtimeLaunchErrorName(error),
        })
        const message = error instanceof Error ? error.message : '发送失败'
        if (rollbackPreparedRuntimeTask) {
          try {
            await rollbackPreparedRuntimeTask()
          } catch (rollbackError) {
            console.error('[Wework] Failed to roll back prepared Runtime task context', {
              address: runtimeAddressLog(optimisticAddress),
              error: rollbackError,
            })
          }
        }
        lifecycleStore.sendRejected(optimisticAddress)
        if (optimisticWorkspace && optimisticWorkspacePath && !options?.ephemeral) {
          dispatch({
            type: 'runtime_task_optimistic_upserted',
            project: runtimeProject,
            workspace: optimisticWorkspace,
            task: buildOptimisticRuntimeTask({
              taskId: optimisticAddress.taskId,
              workspacePath: optimisticWorkspacePath,
              title: createRequest.title ?? buildRuntimeTaskTitle(displayMessage, intent.title),
              runtime,
              status: 'failed',
              workspaceKind: intent.execution?.workspace?.source,
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
      reportError,
      reportSendBlocked,
      runtimeTasks,
      services.attachmentApi,
      services.runtimeWorkApi,
      projectWorktreeBranch,
      state.currentProject,
      state.currentRuntimeTask,
      state.devices,
      state.projects,
      state.runtimeWork,
      state.selectedDeviceWorkspaceId,
      state.standaloneChatKey,
    ]
  )

  const sendCurrentInput = useCallback(
    async (inputOverride?: string, options?: SendCurrentInputOptions) => {
      const launchStartedAt = runtimeLaunchNowMs()
      logRuntimeTaskLaunchTiming('send-current-entered', launchStartedAt, {
        clientUserMessageId:
          options?.optimisticUserMessage?.id ?? options?.clientUserMessageId ?? null,
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
          device => isWorkbenchDeviceOnline(device) && isWeWorkCompatibleDevice(device)
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
        prepared.intent,
        prepared.activeDeviceId,
        {
          launchStartedAt,
          initialGoal: options?.initialGoal,
          initialSupervisor: options?.initialSupervisor,
          onError: options?.onError,
          onRuntimeTaskOptimisticOpen: options?.onRuntimeTaskOptimisticOpen,
          clientUserMessageId: options?.clientUserMessageId,
          optimisticUserMessage: options?.optimisticUserMessage,
          additionalContext: options?.additionalContext,
          cloudProjectId: options?.cloudProjectId,
          ...(options?.runtime ? { runtime: options.runtime } : {}),
          ...(options?.runtimeExecutablePath
            ? { runtimeExecutablePath: options.runtimeExecutablePath }
            : {}),
          ...(options?.runtimePermissionMode
            ? { runtimePermissionMode: options.runtimePermissionMode }
            : {}),
          ...(options && Object.prototype.hasOwnProperty.call(options, 'modelSelection')
            ? { modelSelection: options.modelSelection }
            : {}),
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
      state.devices,
    ]
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

      return sendPreparedRuntimeMessage(message, prepared.intent, prepared.activeDeviceId, {
        optimisticUserMessage: options?.optimisticUserMessage,
        onError: options?.onError,
        onRuntimeTaskOptimisticOpen: options?.onRuntimeTaskOptimisticOpen,
        ephemeral: true,
        sideSource: options?.source && runtimeThreadId(options.source) ? options.source : null,
        openInMainPane: false,
        refreshWorkListsOnResolve: false,
        preserveAttachments: true,
      })
    },
    [buildSendPayload, reportSendBlocked, sendPreparedRuntimeMessage]
  )

  const createTemporaryRuntimeTask = useCallback(
    async (
      input: string,
      options?: CreateTemporaryRuntimeTaskOptions
    ): Promise<RuntimeTaskAddress | false> => {
      const source = await loadTemporaryChatSource(
        options?.source,
        state.runtimeWork,
        executorClient.runtime.listRuntimeWork
      ).catch(() => resolveTemporaryChatSource(options?.source, state.runtimeWork))
      if (!source || !runtimeThreadId(source)) {
        reportSendBlocked('请先打开一个已有对话后再开始临时聊天', undefined, options)
        return false
      }
      return createEphemeralRuntimeTask(input, { ...options, source })
    },
    [createEphemeralRuntimeTask, executorClient, reportSendBlocked, state.runtimeWork]
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

      const taskRequest = options.taskRequest
      const prepared = buildSendPayload(
        message,
        options.attachments,
        options.project,
        taskRequest?.additionalSkills ? false : undefined,
        taskRequest?.additionalSkills,
        taskRequest?.deviceId ?? options.deviceId,
        taskRequest ? (taskRequest.deviceWorkspaceId ?? null) : options.deviceWorkspaceId
      )
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

      const executionModel = taskRequest
        ? {
            modelId: taskRequest.modelId,
            modelType: taskRequest.modelType,
            modelOptions: taskRequest.modelOptions,
          }
        : options.executionModel
      const baseIntent = taskRequest
        ? { ...prepared.intent, execution: taskRequest.execution }
        : prepared.intent
      const intent = executionModel
        ? applyExecutionModelOverride(baseIntent, executionModel)
        : options.modelId
          ? { ...baseIntent, modelId: options.modelId }
          : baseIntent
      const explicitModelSelection = executionModel?.modelId
        ? {
            modelName: executionModel.modelId,
            modelType: (executionModel.modelType as ModelType | null | undefined) ?? null,
            options: executionModel.modelOptions ?? {},
          }
        : (taskRequest?.modelSelection ?? options.modelSelection)
      return sendPreparedRuntimeMessage(message, intent, prepared.activeDeviceId, {
        ...(taskRequest?.runtime || options.runtime
          ? { runtime: taskRequest?.runtime ?? options.runtime }
          : {}),
        initialGoal: taskRequest?.initialGoal ?? options.initialGoal,
        initialSupervisor: taskRequest?.initialSupervisor ?? options.initialSupervisor,
        optimisticUserMessage: options.optimisticUserMessage,
        collaborationMode: options.collaborationMode,
        deliveryId: taskRequest?.deliveryId ?? options.deliveryId,
        cloudProjectId: taskRequest?.cloudProjectId ?? options.cloudProjectId,
        origin: taskRequest?.origin ?? options.origin,
        deviceWorkspaceId: taskRequest
          ? (taskRequest.deviceWorkspaceId ?? null)
          : options.deviceWorkspaceId,
        modelSelection: explicitModelSelection,
        additionalContext: taskRequest?.additionalContext ?? options.additionalContext,
        runtimeExecutablePath: taskRequest?.runtimeExecutablePath,
        runtimePermissionMode: taskRequest?.runtimePermissionMode,
        taskCreateRequest: taskRequest,
        onError: options.onError,
        prepareRuntimeTask: options.prepareRuntimeTask,
        onRuntimeTaskOptimisticOpen: options.onRuntimeTaskOptimisticOpen,
        openInMainPane: false,
      })
    },
    [buildSendPayload, reportSendBlocked, sendPreparedRuntimeMessage, state.devices]
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
    deviceName: device?.name ?? baseWorkspace?.deviceName ?? null,
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
  intent: PreparedRuntimeTaskIntent,
  executionModel: {
    modelId?: string | null
    modelType?: string | null
    modelOptions?: ModelOptions
  }
): PreparedRuntimeTaskIntent {
  const next: PreparedRuntimeTaskIntent = { ...intent }
  delete next.modelId
  delete next.modelType
  delete next.modelOptions
  if (executionModel.modelId) {
    next.modelId = executionModel.modelId
  }
  if (executionModel.modelType) {
    next.modelType = executionModel.modelType as ModelType
  }
  if (executionModel.modelOptions && Object.keys(executionModel.modelOptions).length > 0) {
    next.modelOptions = executionModel.modelOptions
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
