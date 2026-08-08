import type { LocalLoopItemExecution } from '@/api/local/localDelivery'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'
import { createConversationWorkspace } from '@/features/workbench/workbenchRuntimeHelpers'
import type { RuntimeTaskCreateRequest, UnifiedModel } from '@/types/api'

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

  const claimNext = async (deviceId: string) =>
    executionApi.claimNext({
      execution_device_id: deviceId,
      device_capacity: LOCAL_QUEUE_DEVICE_CAPACITY,
      lease_seconds: LOCAL_QUEUE_LEASE_SECONDS,
    })

  const keepRunAlive = (executionId: number, deviceId: string, taskId: string) => {
    // Long runs outlive the 5-minute claim lease. Heartbeat until the run
    // reaches a terminal state (heartbeat returns null for terminal rows) so
    // the lease recovery never requeues a task that is still executing.
    const timer = window.setInterval(() => {
      if (disposed) {
        window.clearInterval(timer)
        return
      }
      void executionApi
        .heartbeat(executionId, deviceId, taskId, LOCAL_QUEUE_LEASE_SECONDS)
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
    let claimDeviceId: string | null = null
    try {
      for (const deviceId of deviceIds) {
        execution = await claimNext(deviceId)
        if (execution) {
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
    const taskId = `codex-queue-${execution.id}-${Date.now()}`
    const prompt = queuePrompt(execution)
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
      teamId: 0,
      runtime: 'codex',
      message: prompt,
      title: execution.task_title,
      cloudProjectId: execution.cloud_project_id,
      deviceId: execution.execution_device_id ?? deviceId,
      ...(boundLocalProjectId != null ? { projectId: boundLocalProjectId } : {}),
      ...(executionModel?.modelId ? { modelId: executionModel.modelId } : {}),
      ...(executionModel?.modelType ? { modelType: executionModel.modelType } : {}),
      ...(executionModel?.modelOptions ? { modelOptions: executionModel.modelOptions } : {}),
      modelSelection: resolvedModel
        ? { modelName: resolvedModel.name, modelType: resolvedModel.type, options: {} }
        : agentModel
          ? { modelName: agentModel, modelType: null, options: {} }
          : null,
      ephemeral: true,
      continuable: true,
      additionalContext: {
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
      const workspacePath = await createConversationWorkspace(
        deviceApi,
        request.deviceId ?? deviceId,
        prompt,
        taskId
      )
      const response = await runtimeWorkApi.createRuntimeTask({ ...request, workspacePath })
      await executionApi.heartbeat(
        execution.id,
        deviceId,
        response.taskId,
        LOCAL_QUEUE_LEASE_SECONDS
      )
      keepRunAlive(execution.id, deviceId, response.taskId)
      console.log('[local-robot-queue] dispatched', {
        executionId: execution.id,
        loopItemId: execution.loop_item_id,
        agentId: execution.agent_id,
        taskId: response.taskId,
        model: execution.agent_model ?? null,
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
      await executionApi.fail(execution.id, errorText).catch(failCause => {
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
