import type { LocalLoopItemExecution } from '@/api/local/localDelivery'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { runtimeTaskReconciliationSnapshot } from '@/features/workbench/runtimeTaskLifecycle/projection'
import type { RuntimeTaskCreateRequest } from '@/types/api'

const LOCAL_QUEUE_POLL_MS = 3000
const LOCAL_QUEUE_DEVICE_CACHE_MS = 30_000
const LOCAL_QUEUE_HEARTBEAT_INTERVAL_MS = 60_000
const LOCAL_QUEUE_RECOVERY_INTERVAL_MS = 60_000
const LOCAL_QUEUE_LEASE_SECONDS = 300

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
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

export async function stopLocalRobotQueueExecution(
  executionApi: NonNullable<WorkbenchServices['localLoopItemExecutionApi']>,
  runtimeWorkApi: WorkbenchServices['runtimeWorkApi'],
  executionId: number
): Promise<LocalLoopItemExecution> {
  const execution = await executionApi.cancel(executionId)
  if (execution.status !== 'cancel_requested') return execution
  if (!execution.runtime_device_id || !execution.runtime_task_id) {
    throw new Error('Delivered execution has no runtime identity')
  }
  if (!runtimeWorkApi) throw new Error('Runtime cancellation API is unavailable')
  await runtimeWorkApi.cancelRuntimeTask({
    deviceId: execution.runtime_device_id,
    taskId: execution.runtime_task_id,
  })
  return execution
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
    const deviceIds = await localDeviceIds()
    if (deviceIds.length === 0) return
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
    let startRequested = false
    let runtimeAccepted = false
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
      const payloadBot = runtimeBot(runtimePayload.bot)
      const request: RuntimeTaskCreateRequest = {
        ...(runtimePayload as unknown as RuntimeTaskCreateRequest),
        schemaVersion: 2,
        taskId,
        runtime: 'codex',
        message: prompt,
        title,
        cloudProjectId,
        deviceId,
        bot: payloadBot,
        origin: origin as RuntimeTaskCreateRequest['origin'],
        additionalContext: additionalContext as RuntimeTaskCreateRequest['additionalContext'],
        standaloneChatWorkspace,
      }

      console.log('[local-robot-queue] claimed transient runtime payload', {
        executionId: execution.id,
        runtimeTaskId: taskId,
        botCount: payloadBot.length,
        hasExecutionRequest: false,
        model: request.modelId ?? null,
        hasAdditionalContext: true,
      })
      if (isCloudExecution) {
        const fenced = await cloudExecutionApi!.startRequested(execution, deviceId, taskId)
        if (!fenced) throw new Error('Execution is no longer dispatchable')
      } else {
        const fenced = await executionApi.startRequested(
          execution.id,
          deviceId,
          taskId,
          LOCAL_QUEUE_LEASE_SECONDS
        )
        if (!fenced) throw new Error('Execution is no longer dispatchable')
      }
      startRequested = true
      const response = await runtimeWorkApi.createRuntimeTask(request)
      if (response.taskId !== taskId) {
        throw new Error(`Runtime accepted task '${response.taskId}' instead of '${taskId}'`)
      }
      runtimeAccepted = true
      if (isCloudExecution) {
        await cloudExecutionApi!.runtimeStart(
          execution,
          deviceId,
          response.taskId,
          prompt,
          request.modelId ?? null
        )
      } else {
        await executionApi.runtimeStart(
          execution.id,
          deviceId,
          response.taskId,
          LOCAL_QUEUE_LEASE_SECONDS
        )
      }
      keepRunAlive(execution, deviceId, response.taskId, isCloudExecution)
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
      const fail =
        startRequested && isCloudExecution
          ? cloudExecutionApi!.dispatchUnknown(execution, deviceId, taskId, errorText)
          : startRequested
            ? executionApi.dispatchUnknown(execution.id, deviceId, taskId, errorText)
            : isCloudExecution
              ? cloudExecutionApi!.dispatchFailed(execution, errorText)
              : executionApi.dispatchFailed(execution.id, errorText)
      await fail.catch(failCause => {
        console.warn('[local-robot-queue] failed to persist dispatch outcome', {
          error: failCause instanceof Error ? failCause.message : String(failCause),
        })
      })
      if (runtimeAccepted) {
        console.warn('[local-robot-queue] Runtime accepted the task; reconciliation owns outcome', {
          executionId: execution.id,
          taskId,
        })
      }
    }
  }

  let recoveryCountdown = LOCAL_QUEUE_RECOVERY_INTERVAL_MS
  const recover = async () => {
    try {
      const result = await executionApi.recoverStale()
      const staleExecutions = await executionApi.listStale()
      if (staleExecutions.length > 0) {
        const runtimeWork = await runtimeWorkApi.listRuntimeWork()
        const snapshots = new Map<
          string,
          { status: string; running: boolean; turnStatus: string | null }
        >()
        const workspaces = [
          ...runtimeWork.projects.flatMap(project => project.deviceWorkspaces),
          ...runtimeWork.chats,
        ]
        for (const workspace of workspaces) {
          for (const task of workspace.tasks) {
            const truth = runtimeTaskReconciliationSnapshot(task)
            snapshots.set(`${workspace.deviceId}:${task.taskId}`, {
              status: truth.runtimeStatus,
              running: truth.running,
              turnStatus: truth.turnStatus,
            })
          }
        }
        for (const execution of staleExecutions) {
          const address = `${execution.runtime_device_id}:${execution.runtime_task_id}`
          const snapshot = snapshots.get(address)
          await executionApi.reconcile(execution.id, {
            runtime_status: snapshot?.status ?? 'missing',
            running: snapshot?.running ?? false,
            turn_status: snapshot?.turnStatus ?? null,
          })
        }
      }
      if (result.requeued > 0 || result.unknown > 0) {
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
    const recoveryDue = recoveryCountdown <= 0
    if (recoveryDue) {
      recoveryCountdown = LOCAL_QUEUE_RECOVERY_INTERVAL_MS
    }
    void (recoveryDue ? recover() : Promise.resolve()).then(dispatchOnce).finally(() => {
      dispatching = false
    })
  }, LOCAL_QUEUE_POLL_MS)

  return () => {
    disposed = true
    window.clearInterval(interval)
  }
}
