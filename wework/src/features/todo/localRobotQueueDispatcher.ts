import type { LocalLoopItemExecution } from '@/api/local/localDelivery'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { runtimeTaskReconciliationSnapshot } from '@/features/workbench/runtimeTaskLifecycle/projection'
import type { RuntimeTaskCreateRequest } from '@/types/api'

const LOCAL_QUEUE_POLL_MS = 3000
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
  const runtimeWorkApi = services.runtimeWorkApi
  if (!executionApi || !runtimeWorkApi) {
    console.warn('[local-robot-queue] dispatcher unavailable', {
      hasExecutionApi: Boolean(executionApi),
      hasRuntimeWorkApi: Boolean(runtimeWorkApi),
    })
    return () => undefined
  }

  let disposed = false
  let dispatching = false
  const keepRunAlive = (execution: LocalLoopItemExecution, deviceId: string, taskId: string) => {
    // Long runs outlive the 5-minute claim lease. Heartbeat until the run
    // reaches a terminal state (heartbeat returns null for terminal rows) so
    // the lease recovery never requeues a task that is still executing.
    const timer = window.setInterval(() => {
      if (disposed) {
        window.clearInterval(timer)
        return
      }
      const heartbeat = executionApi.heartbeat(
        execution.id,
        deviceId,
        taskId,
        LOCAL_QUEUE_LEASE_SECONDS
      )
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
    let execution: LocalLoopItemExecution | null
    try {
      execution = await executionApi.claimNext({
        lease_seconds: LOCAL_QUEUE_LEASE_SECONDS,
      })
    } catch (cause) {
      console.warn('[local-robot-queue] claim failed', {
        error: cause instanceof Error ? cause.message : String(cause),
      })
      return
    }
    if (!execution) return
    const deviceId = nonEmptyString(execution.execution_device_id)
    if (!deviceId) {
      throw new Error('Claimed local execution has no execution device')
    }

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
      const fenced = await executionApi.startRequested(
        execution.id,
        deviceId,
        taskId,
        LOCAL_QUEUE_LEASE_SECONDS
      )
      if (!fenced) throw new Error('Execution is no longer dispatchable')
      startRequested = true
      const response = await runtimeWorkApi.createRuntimeTask(request)
      if (response.taskId !== taskId) {
        throw new Error(`Runtime accepted task '${response.taskId}' instead of '${taskId}'`)
      }
      runtimeAccepted = true
      await executionApi.runtimeStart(
        execution.id,
        deviceId,
        response.taskId,
        LOCAL_QUEUE_LEASE_SECONDS
      )
      keepRunAlive(execution, deviceId, response.taskId)
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
      const fail = startRequested
        ? executionApi.dispatchUnknown(execution.id, deviceId, taskId, errorText)
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
