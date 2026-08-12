import type { LocalLoopItemExecution } from '@/api/local/localDelivery'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'
import { createConversationWorkspace } from '@/features/workbench/workbenchRuntimeHelpers'
import type { RuntimeAdditionalContext, RuntimeTaskCreateRequest, UnifiedModel } from '@/types/api'

const LOCAL_QUEUE_POLL_MS = 3000
const LOCAL_QUEUE_DEVICE_CACHE_MS = 30_000
const LOCAL_QUEUE_HEARTBEAT_INTERVAL_MS = 60_000
const LOCAL_QUEUE_RECOVERY_INTERVAL_MS = 60_000
const LOCAL_QUEUE_DEVICE_CAPACITY = 5
const LOCAL_QUEUE_LEASE_SECONDS = 300

function robotRoleDescription(agentName: string, systemPrompt: string): string {
  return systemPrompt
    ? `你是 ${agentName}，这个项目任务的 AI 执行者。\n${systemPrompt}`
    : `你是 ${agentName}，这个项目任务的 AI 执行者。`
}

function queuePrompt(execution: LocalLoopItemExecution): string {
  const commentText =
    typeof execution.execution_payload?.text === 'string'
      ? (execution.execution_payload.text as string)
      : ''
  // The task title/description is not embedded here; the AI reads the bound
  // task itself through wework_space (get_board_item). The sent content is
  // the robot's role description plus the triggering comment requirement.
  const role = robotRoleDescription(execution.agent_name, execution.agent_system_prompt ?? '')
  if (commentText) {
    return `${role}\n\n以下是任务评论中提出的最新要求：\n${commentText}`
  }
  return role
}

/**
 * Dispatch local-project robot executions from the App, the same way cloud
 * projects with local execution are dispatched: claim the queued run, build
 * the runtime task with the complete App payload builder (model catalog, cloud
 * gateway, standalone workspace) and start it on the executor. The executor
 * only stores the run and writes the outcome back.
 */
export function startLocalRobotQueueDispatcher(services: WorkbenchServices): () => void {
  const executionApi = services.localLoopItemExecutionApi
  const cloudExecutionApi = services.projectAutomationApi
  const runtimeWorkApi = services.runtimeWorkApi
  const deviceApi = services.deviceApi
  const modelApi = services.modelApi
  if (!executionApi || !runtimeWorkApi || !deviceApi) {
    console.warn('[local-robot-queue] dispatcher unavailable', {
      hasExecutionApi: Boolean(executionApi),
      hasRuntimeWorkApi: Boolean(runtimeWorkApi),
      hasDeviceApi: Boolean(deviceApi),
    })
    return () => undefined
  }

  let disposed = false
  let dispatching = false
  let resolvedDeviceIds: string[] | null = null
  let deviceCacheExpiresAt = 0
  let modelCache: UnifiedModel[] | null = null
  let modelCacheExpiresAt = 0

  // Resolve the robot's configured model to its full runtime selection (cloud
  // gateway identity, catalog id, provider) the same way a chat send does.
  // Without this, cloud/public models fall back to the local Codex account
  // and the run fails before it starts.
  const modelsByAgentModel = async (): Promise<Map<string, UnifiedModel>> => {
    const now = Date.now()
    if (modelCache && now < modelCacheExpiresAt) {
      return new Map(modelCache.map(model => [model.name, model]))
    }
    if (!modelApi?.listModels) return new Map()
    try {
      const response = await modelApi.listModels()
      modelCache = response.data
      modelCacheExpiresAt = now + LOCAL_QUEUE_DEVICE_CACHE_MS
      return new Map(response.data.map(model => [model.name, model]))
    } catch (cause) {
      console.warn('[local-robot-queue] failed to resolve model catalog', {
        error: cause instanceof Error ? cause.message : String(cause),
      })
      return new Map()
    }
  }

  // A robot may be bound to any local-capable device (the desktop executor
  // itself is `local`, companion apps are `app`). Claim from every one of
  // them so robots bound to a different local device are not stuck in queue.
  const localDeviceIds = async (): Promise<string[]> => {
    const now = Date.now()
    if (resolvedDeviceIds && now < deviceCacheExpiresAt) return resolvedDeviceIds
    try {
      const devices = await deviceApi.listDevices()
      const ids = Array.from(
        new Set(
          devices
            .filter(device => device.device_type === 'local' || device.device_type === 'app')
            .map(device => device.device_id)
            .filter((deviceId): deviceId is string => Boolean(deviceId))
        )
      )
      resolvedDeviceIds = ids
      deviceCacheExpiresAt = now + LOCAL_QUEUE_DEVICE_CACHE_MS
      return ids
    } catch (cause) {
      console.warn('[local-robot-queue] failed to resolve local devices', {
        error: cause instanceof Error ? cause.message : String(cause),
      })
    }
    return resolvedDeviceIds ?? []
  }

  const claimNext = async (deviceId: string) => {
    const claim = {
      execution_device_id: deviceId,
      device_capacity: LOCAL_QUEUE_DEVICE_CAPACITY,
      lease_seconds: LOCAL_QUEUE_LEASE_SECONDS,
    }
    const cloudExecution = await cloudExecutionApi?.claimNext(claim)
    if (cloudExecution) return { execution: cloudExecution, cloud: true }
    const localExecution = await executionApi.claimNext(claim)
    return localExecution ? { execution: localExecution, cloud: false } : null
  }

  const keepRunAlive = (
    execution: LocalLoopItemExecution,
    deviceId: string,
    taskId: string,
    cloud: boolean
  ) => {
    // Long runs outlive the 5-minute claim lease. Heartbeat until the run
    // reaches a terminal state (heartbeat returns null for terminal rows) so
    // the lease recovery never requeues a task that is still executing.
    const timer = window.setInterval(() => {
      if (disposed) {
        window.clearInterval(timer)
        return
      }
      const heartbeat = cloud
        ? cloudExecutionApi!.heartbeat(execution, deviceId, taskId, LOCAL_QUEUE_LEASE_SECONDS)
        : executionApi.heartbeat(execution.id, deviceId, taskId, LOCAL_QUEUE_LEASE_SECONDS)
      void heartbeat
        .then(updated => {
          if (!updated) window.clearInterval(timer)
        })
        .catch(() => {
          // Transient IPC failures keep the current lease; recovery handles
          // runs that truly expired while the app was unavailable.
        })
    }, LOCAL_QUEUE_HEARTBEAT_INTERVAL_MS)
  }

  const dispatchOnce = async (): Promise<void> => {
    let deviceIds = await localDeviceIds()
    if (deviceIds.length === 0) deviceIds = ['local-device']
    let execution: LocalLoopItemExecution | null = null
    let isCloudExecution = false
    let claimDeviceId: string | null = null
    try {
      for (const deviceId of deviceIds) {
        const claimed = await claimNext(deviceId)
        if (claimed) {
          execution = claimed.execution
          isCloudExecution = claimed.cloud
          claimDeviceId = deviceId
          break
        }
      }
    } catch (cause) {
      console.warn('[local-robot-queue] claim failed', {
        error: cause instanceof Error ? cause.message : String(cause),
      })
      return
    }
    if (!execution) return
    const deviceId = claimDeviceId ?? 'local-device'

    // Bind the run to a local code project: the user-selected project on the
    // triggering comment wins, then the robot's bound project, then nothing.
    let boundLocalProjectId: number | null =
      typeof execution.execution_payload?.local_project_id === 'number'
        ? execution.execution_payload.local_project_id
        : null
    if (boundLocalProjectId == null && services.projectChatAgentApi) {
      try {
        const agents = await services.projectChatAgentApi.list(execution.cloud_project_id)
        boundLocalProjectId =
          agents.find(agent => agent.id === execution.agent_id)?.localProjectId ?? null
      } catch {
        // Agent list failures keep the current no-project behavior.
      }
    }
    let boundWorkspacePath: string | null = null
    if (boundLocalProjectId != null) {
      try {
        // Resolve the bound project's workspace from the same runtime work
        // registry the chat send uses, so a robot bound to a project runs in
        // that project's directory instead of a fresh conversation workspace.
        const runtimeWork = await services.runtimeWorkApi?.listRuntimeWork()
        const projectWork = runtimeWork?.projects.find(
          item => item.project.id === boundLocalProjectId
        )
        const workspace = projectWork?.deviceWorkspaces.find(
          candidate =>
            candidate.deviceId === (execution.execution_device_id ?? deviceId) &&
            candidate.available
        )
        boundWorkspacePath =
          workspace?.workspacePath ?? projectWork?.project.roots?.[0]?.path ?? null
      } catch (cause) {
        console.warn('[local-robot-queue] failed to resolve bound project workspace', {
          projectId: boundLocalProjectId,
          error: cause instanceof Error ? cause.message : String(cause),
        })
      }
    }
    // The backend binds the canonical runtime task identity at claim time.
    // Use it verbatim so runtime events always match the execution row; the
    // transport must never mint its own task id.
    const taskId = execution.runtime_task_id ?? `codex-queue-${execution.id}`
    const backendPayload = execution.execution_payload ?? {}
    const payloadMessage =
      typeof backendPayload.message === 'string' && backendPayload.message.trim()
        ? backendPayload.message
        : null
    const payloadContext =
      backendPayload.additionalContext && typeof backendPayload.additionalContext === 'object'
        ? (backendPayload.additionalContext as RuntimeAdditionalContext)
        : null
    const backendExecutionRequest =
      backendPayload.executionRequest && typeof backendPayload.executionRequest === 'object'
        ? (backendPayload.executionRequest as Record<string, unknown>)
        : null
    const payloadBot =
      Array.isArray(backendExecutionRequest?.bot) && backendExecutionRequest.bot.length > 0
        ? (backendExecutionRequest.bot as Array<Record<string, unknown>>)
        : null
    const payloadModelConfig =
      backendExecutionRequest?.model_config &&
      typeof backendExecutionRequest.model_config === 'object'
        ? (backendExecutionRequest.model_config as Record<string, unknown>)
        : null
    console.log('[local-robot-queue] claimed execution payload', {
      executionId: execution.id,
      runtimeTaskId: taskId,
      hasExecutionRequest: Boolean(backendExecutionRequest),
      botCount: payloadBot?.length ?? 0,
      hasModelConfig: Boolean(payloadModelConfig),
      modelConfigBaseUrl: payloadModelConfig?.base_url ?? null,
      hasAdditionalContext: Boolean(payloadContext),
      boundLocalProjectId,
      boundWorkspacePath,
    })
    // The robot prompt and bound-task context are backend-owned business
    // content; only fall back to local derivation for legacy payloads.
    const prompt = payloadMessage ?? queuePrompt(execution)
    const systemPrompt = execution.agent_system_prompt ?? ''
    const roleDescription = robotRoleDescription(execution.agent_name, systemPrompt)
    const agentModel = execution.agent_model ?? null
    const resolvedModel = agentModel ? ((await modelsByAgentModel()).get(agentModel) ?? null) : null
    const executionModel = resolvedModel
      ? selectedModelExecutionFields(resolvedModel, {})
      : agentModel
        ? { modelId: agentModel, modelType: null, modelOptions: {} }
        : null
    const request: RuntimeTaskCreateRequest = {
      taskId,
      teamId: typeof backendPayload.teamId === 'number' ? backendPayload.teamId : 0,
      runtime: 'codex',
      message: prompt,
      title: execution.task_title,
      cloudProjectId: execution.cloud_project_id,
      origin: {
        type: 'board_task',
        cloudProjectId: execution.cloud_project_id,
        loopItemId: execution.loop_item_id,
      },
      deviceId: execution.execution_device_id ?? deviceId,
      ...(boundLocalProjectId != null ? { projectId: boundLocalProjectId } : {}),
      ...(payloadBot ? { bot: payloadBot } : {}),
      ...(payloadModelConfig ? { modelConfig: payloadModelConfig } : {}),
      ...(executionModel?.modelId ? { modelId: executionModel.modelId } : {}),
      ...(executionModel?.modelType ? { modelType: executionModel.modelType } : {}),
      ...(executionModel?.modelOptions ? { modelOptions: executionModel.modelOptions } : {}),
      modelSelection: resolvedModel
        ? { modelName: resolvedModel.name, modelType: resolvedModel.type, options: {} }
        : agentModel
          ? { modelName: agentModel, modelType: null, options: {} }
          : null,
      additionalContext: payloadContext ?? {
        projectChat: {
          kind: 'application',
          value: [
            'This run is bound to the current project space board task.',
            `Reply to task cloud://projects/${execution.cloud_project_id}/todos/${execution.loop_item_id}.`,
            'Read the task with the wework_space get_board_item tool before executing; the task link already contains the space_id and item_id, so do not call list_spaces to find the project.',
            'Your final response is a reviewable task comment. Report actual changes, verification, unfinished work, and risks.',
          ].join('\n'),
        },
        projectChatAgent: {
          kind: 'application',
          value: roleDescription,
        },
      },
    }

    try {
      if (boundLocalProjectId != null && !boundWorkspacePath) {
        throw new Error(
          `Bound local project ${boundLocalProjectId} is unavailable on device ${request.deviceId ?? deviceId}`
        )
      }
      // Open the reviewable AI activity before the executor can emit events:
      // the canonical runtime identity is already bound at claim time, so the
      // comment exists first and the event write-back can only reuse it.
      if (isCloudExecution) {
        await cloudExecutionApi!.runtimeStart(
          execution,
          deviceId,
          taskId,
          prompt,
          executionModel?.modelId ?? agentModel ?? null
        )
      }
      const workspacePath =
        boundWorkspacePath ??
        (await createConversationWorkspace(deviceApi, request.deviceId ?? deviceId, prompt, taskId))
      const response = await runtimeWorkApi.createRuntimeTask({ ...request, workspacePath })
      if (isCloudExecution) {
        await cloudExecutionApi!.heartbeat(
          execution,
          deviceId,
          response.taskId,
          LOCAL_QUEUE_LEASE_SECONDS
        )
      } else {
        await executionApi.heartbeat(
          execution.id,
          deviceId,
          response.taskId,
          LOCAL_QUEUE_LEASE_SECONDS
        )
      }
      keepRunAlive(execution, deviceId, response.taskId, isCloudExecution)
      if (isCloudExecution) {
        let terminalReported = false
        let unsubscribe: () => void = () => undefined
        const reportOnce = (report: () => Promise<unknown>) => {
          if (terminalReported) return
          terminalReported = true
          unsubscribe()
          void report().catch(cause => {
            console.warn('[local-robot-queue] failed to report cloud terminal state', {
              executionId: execution.id,
              error: cause instanceof Error ? cause.message : String(cause),
            })
          })
        }
        unsubscribe = services.chatStream.subscribe({
          scope: { deviceId, taskId: response.taskId },
          onChatDone: payload => {
            if (payload.taskId !== response.taskId) return
            const note = typeof payload.result?.value === 'string' ? payload.result.value : null
            reportOnce(() => cloudExecutionApi!.complete(execution, note))
          },
          onChatError: payload => {
            if (payload.taskId !== response.taskId) return
            reportOnce(() => cloudExecutionApi!.fail(execution, payload.error))
          },
        })
      }
      console.log('[local-robot-queue] dispatched', {
        executionId: execution.id,
        loopItemId: execution.loop_item_id,
        agentId: execution.agent_id,
        taskId: response.taskId,
        model: execution.agent_model ?? null,
        botCount: payloadBot?.length ?? 0,
        modelConfigBaseUrl: payloadModelConfig?.base_url ?? null,
      })
    } catch (cause) {
      const errorText = cause instanceof Error ? cause.message : String(cause)
      console.error('[local-robot-queue] dispatch failed', {
        executionId: execution.id,
        loopItemId: execution.loop_item_id,
        agentId: execution.agent_id,
        taskId,
        error: errorText,
      })
      const fail = isCloudExecution
        ? cloudExecutionApi!.fail(execution, errorText)
        : executionApi.fail(execution.id, errorText)
      await fail.catch(failCause => {
        console.warn('[local-robot-queue] failed to mark execution failed', {
          error: failCause instanceof Error ? failCause.message : String(failCause),
        })
      })
    }
  }

  let recoveryCountdown = LOCAL_QUEUE_RECOVERY_INTERVAL_MS
  const recover = async () => {
    try {
      const result = await executionApi.recoverStale()
      if (result.requeued > 0 || result.failed > 0) {
        console.log('[local-robot-queue] recovered stale runs', result)
      }
    } catch (cause) {
      console.warn('[local-robot-queue] recovery failed', {
        error: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  const interval = window.setInterval(() => {
    if (disposed || dispatching) return
    dispatching = true
    recoveryCountdown -= LOCAL_QUEUE_POLL_MS
    void dispatchOnce().finally(() => {
      dispatching = false
    })
    if (recoveryCountdown <= 0) {
      recoveryCountdown = LOCAL_QUEUE_RECOVERY_INTERVAL_MS
      void recover()
    }
  }, LOCAL_QUEUE_POLL_MS)

  return () => {
    disposed = true
    window.clearInterval(interval)
  }
}
