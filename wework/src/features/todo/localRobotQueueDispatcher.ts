import type { LocalLoopItemExecution } from '@/api/local/localDelivery'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { createConversationWorkspace } from '@/features/workbench/workbenchRuntimeHelpers'
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'
import type { RuntimeTaskCreateRequest } from '@/types/api'

const LOCAL_QUEUE_POLL_MS = 3000
const LOCAL_QUEUE_DEVICE_CACHE_MS = 30_000
const LOCAL_QUEUE_HEARTBEAT_INTERVAL_MS = 60_000
const LOCAL_QUEUE_RECOVERY_INTERVAL_MS = 60_000
const LOCAL_QUEUE_DEVICE_CAPACITY = 5
const LOCAL_QUEUE_LEASE_SECONDS = 300

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  throw new Error(`Transient runtime payload is missing ${field}`)
}

function runtimeBot(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new Error('Transient runtime payload is missing bot identity')
  }
  const bots = value.map(recordValue).filter((bot): bot is Record<string, unknown> => bot !== null)
  if (bots.length !== value.length || bots.length === 0) {
    throw new Error('Transient runtime payload has an invalid bot identity')
  }
  return bots
}

/**
 * Dispatch local-project robot executions from the App, the same way cloud
 * projects with local execution are dispatched: claim the queued run, resolve
 * local model configuration immediately before execution, and start it on the
 * executor. Queue rows retain execution identities only; current model
 * configuration and credentials are resolved at claim time and never written
 * back to the queue.
 */
export function startLocalRobotQueueDispatcher(services: WorkbenchServices): () => void {
  const executionApi = services.localLoopItemExecutionApi
  const cloudExecutionApi = services.projectAutomationApi
  const runtimeWorkApi = services.runtimeWorkApi
  const deviceApi = services.deviceApi
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

    const taskId = nonEmptyString(execution.runtime_task_id) ?? ''
    try {
      const runtimePayload = recordValue(execution.runtime_payload)
      if (!runtimePayload) {
        throw new Error('Execution claim is missing its transient runtime payload')
      }
      const prompt = nonEmptyString(runtimePayload.message)
      const payloadTaskId = nonEmptyString(runtimePayload.taskId)
      if (!taskId || !payloadTaskId || !prompt) {
        throw new Error('Transient runtime payload is missing task identity or prompt')
      }
      if (payloadTaskId !== taskId) {
        throw new Error(`Runtime task identity '${payloadTaskId}' does not match '${taskId}'`)
      }
      if (runtimePayload.runtime !== 'codex') {
        throw new Error('Transient runtime payload must target the Codex runtime')
      }
      const cloudProjectId = nonEmptyString(runtimePayload.cloudProjectId)
      if (!cloudProjectId || cloudProjectId !== execution.cloud_project_id) {
        throw new Error('Transient runtime payload does not match the claimed project')
      }
      if (execution.execution_device_id !== deviceId) {
        throw new Error('Execution device does not match the claiming device')
      }

      const payloadLocalProjectId = runtimePayload.local_project_id
      const boundLocalProjectId =
        typeof payloadLocalProjectId === 'number' && payloadLocalProjectId > 0
          ? payloadLocalProjectId
          : null
      let boundWorkspacePath: string | null = null
      if (boundLocalProjectId != null) {
        const runtimeWork = await services.runtimeWorkApi?.listRuntimeWork()
        const projectWork = runtimeWork?.projects.find(
          item => item.project.id === boundLocalProjectId
        )
        const workspace = projectWork?.deviceWorkspaces.find(
          candidate => candidate.deviceId === deviceId && candidate.available
        )
        boundWorkspacePath =
          workspace?.workspacePath ?? projectWork?.project.roots?.[0]?.path ?? null
      }
      if (boundLocalProjectId != null && !boundWorkspacePath) {
        throw new Error(
          `Bound local project ${boundLocalProjectId} is unavailable on device ${deviceId}`
        )
      }

      const title = typeof runtimePayload.title === 'string' ? runtimePayload.title : null
      const origin = recordValue(runtimePayload.origin)
      const additionalContext = recordValue(runtimePayload.additionalContext)
      const standaloneChatWorkspace = runtimePayload.standaloneChatWorkspace
      if (
        title == null ||
        !origin ||
        !additionalContext ||
        typeof standaloneChatWorkspace !== 'boolean'
      ) {
        throw new Error('Transient runtime payload is missing execution context')
      }
      if (!['board_comment', 'board_task', 'project_automation'].includes(String(origin.type))) {
        throw new Error('Transient runtime payload has an invalid execution origin')
      }
      if (
        nonEmptyString(origin.cloudProjectId) !== cloudProjectId ||
        nonEmptyString(origin.loopItemId) !== execution.loop_item_id
      ) {
        throw new Error('Transient runtime payload origin does not match the claimed execution')
      }

      if (runtimePayload.executionRequest != null) {
        throw new Error(
          'Local execution claims must not contain a backend-materialized execution request'
        )
      }
      let modelFields: Pick<RuntimeTaskCreateRequest, 'modelId' | 'modelType' | 'modelOptions'> = {}
      const requestedModelName = nonEmptyString(runtimePayload.modelId)
      if (requestedModelName) {
        const modelResponse = await services.modelApi.listModels()
        const matchingModels = modelResponse.data.filter(
          model =>
            model.name === requestedModelName &&
            model.isActive !== false &&
            !model.compatibilityDisabled
        )
        if (matchingModels.length !== 1) {
          throw new Error(
            `Execution model '${requestedModelName}' is unavailable in the current App model catalog`
          )
        }
        modelFields = selectedModelExecutionFields(matchingModels[0], {})
        if (!modelFields.modelId) {
          throw new Error(`Execution model '${requestedModelName}' has no runtime identity`)
        }
      }

      const payloadBot = runtimeBot(runtimePayload.bot)
      const request: RuntimeTaskCreateRequest = {
        taskId,
        teamId: requiredNumber(runtimePayload.teamId, 'team identity'),
        runtime: 'codex',
        message: prompt,
        title,
        cloudProjectId,
        deviceId,
        bot: payloadBot,
        origin: origin as RuntimeTaskCreateRequest['origin'],
        additionalContext: additionalContext as RuntimeTaskCreateRequest['additionalContext'],
        standaloneChatWorkspace,
        ...modelFields,
        ...(boundLocalProjectId != null ? { projectId: boundLocalProjectId } : {}),
      }

      console.log('[local-robot-queue] claimed transient runtime payload', {
        executionId: execution.id,
        runtimeTaskId: taskId,
        botCount: payloadBot.length,
        hasExecutionRequest: false,
        model: request.modelId ?? null,
        hasAdditionalContext: true,
        boundLocalProjectId,
        boundWorkspacePath,
      })
      // Open the reviewable AI activity before the executor can emit events:
      // the canonical runtime identity is already bound at claim time, so the
      // comment exists first and the event write-back can only reuse it.
      if (isCloudExecution) {
        await cloudExecutionApi!.runtimeStart(
          execution,
          deviceId,
          taskId,
          prompt,
          request.modelId ?? null
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
        botCount: payloadBot.length,
        runtimeRequestSource: 'app',
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
