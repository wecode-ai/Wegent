import { changeRequestResourceEventKeys } from '@/features/workbench/changeRequestObservations'
import type { TaskChangeRequestSnapshot } from '@/api/changeRequests'
import type { CloudTodoBoardTaskBinding } from './CloudTodoBoardCard'
import type { CloudTodoWorkspaceObservation } from './cloudTodoWorkspaceObservation'
import {
  autoRepairStatus,
  buildChangeRequestRepairPrompt,
  changeRequestRepairEventKey,
  claimChangeRequestAutoRepair,
  completeChangeRequestAutoRepair,
} from '@/features/workbench/changeRequestStatus'
import { hydrateRuntimeTaskAddress } from '@/features/workbench/workbenchRuntimeHelpers'
import { createRuntimeUserMessage } from '@/features/workbench/runtimeUserMessage'
import { projectSpaceKey, projectSpaceRef } from './projectSpaceSelection'
export function createCloudTodoChangeRequestRepair() {
  let current: CloudTodoWorkspaceObservation | undefined
  let key: string | undefined
  let monitor: CloudTodoWorkspaceObservation['monitor']
  let generation = 0
  let releases: Array<() => void> = []
  const stop = () => {
    generation++
    releases.forEach(release => release())
    releases = []
  }
  const repair = async (
    binding: CloudTodoBoardTaskBinding,
    snapshot: TaskChangeRequestSnapshot,
    projectKey: string,
    automatic = false
  ) => {
    const input = current
    const project = input?.project
    const request = snapshot.changeRequest
    if (
      !input ||
      !request ||
      !project ||
      !input.workbench ||
      projectSpaceKey(projectSpaceRef(project)) !== projectKey
    )
      return
    const hydrated = hydrateRuntimeTaskAddress(input.props.runtimeWork, {
      deviceId: binding.device_id,
      taskId: binding.task_id,
    })
    const address = binding.modelSelection
      ? {
          ...hydrated,
          runtimeHandle: {
            ...(hydrated.runtimeHandle ?? {}),
            modelSelection: binding.modelSelection,
          },
        }
      : hydrated
    const prompt = buildChangeRequestRepairPrompt(
      request,
      binding.task_title || binding.task_id,
      input.t,
      project.pull_request_automation?.prompt
    )
    const resourceEventKeys = automatic ? changeRequestResourceEventKeys(snapshot) : []
    const accepted = await input.workbench.sendRuntimePaneMessage(
      {
        address,
        message: prompt,
        source: { source: automatic ? 'connection_event' : 'manual' },
        ...(resourceEventKeys.length ? { resourceEventKeys, queueIfBusy: true } : {}),
        cloudProjectId: String(project.id),
      },
      { optimisticUserMessage: automatic ? undefined : createRuntimeUserMessage(prompt) }
    )
    if (!accepted) throw new Error(input.repairFailedError)
  }
  const inspect = () => {
    const input = current
    const project = input?.project
    if (!input || !project?.pull_request_automation?.enabled || !input.monitor) return
    const epoch = generation
    for (const [itemId, bindings] of Object.entries(input.boardBindings)) {
      const binding = bindings.find(candidate => candidate.running) ?? bindings[0]
      if (!binding?.changeRequestTarget) continue
      const snapshot = input.monitor.getSnapshot(binding.changeRequestTarget)
      const request = snapshot?.changeRequest
      const status = request ? autoRepairStatus(request) : null
      if (
        !snapshot ||
        snapshot.stale ||
        snapshot.error ||
        !request ||
        !status ||
        !project.pull_request_automation.statuses.includes(status)
      )
        continue
      if (input.monitor.hasHandledChange(binding.changeRequestTarget, request)) continue
      const eventKey = `${itemId}\0${binding.task_id}\0${changeRequestRepairEventKey(request)}`
      if (!claimChangeRequestAutoRepair(eventKey)) continue
      queueMicrotask(() => {
        if (epoch !== generation) {
          completeChangeRequestAutoRepair(eventKey, false)
          return
        }
        void repair(binding, snapshot, projectSpaceKey(projectSpaceRef(project)), true)
          .then(() => completeChangeRequestAutoRepair(eventKey, true))
          .catch(error => {
            completeChangeRequestAutoRepair(eventKey, false)
            console.error('[Wework change requests] Automatic repair failed', {
              itemId,
              taskId: binding.task_id,
              error,
            })
          })
      })
    }
  }
  return {
    repair,
    observe(input: CloudTodoWorkspaceObservation) {
      current = input
      const project = input.project
      const ready =
        project &&
        (project.location === 'cloud' ||
          projectSpaceKey(projectSpaceRef(project)) === input.localBindingsProjectKey)
      const enabled = ready && project?.pull_request_automation?.enabled && input.monitor
      const targets = Object.entries(input.boardBindings).flatMap(([itemId, bindings]) => {
        const binding = bindings.find(candidate => candidate.running) ?? bindings[0]
        return binding?.changeRequestTarget ? [[itemId, binding] as const] : []
      })
      const nextKey = enabled
        ? JSON.stringify([
            input.props.user.id,
            projectSpaceKey(projectSpaceRef(project!)),
            project!.pull_request_automation,
            targets.map(([id, binding]) => [
              id,
              binding.device_id,
              binding.task_id,
              binding.changeRequestTarget,
            ]),
          ])
        : undefined
      if (key !== nextKey || monitor !== input.monitor) {
        stop()
        key = nextKey
        monitor = input.monitor
        if (enabled) {
          releases.push(input.monitor!.subscribe(inspect))
          for (const [, binding] of targets)
            releases.push(input.monitor!.register(binding.changeRequestTarget!))
        }
      }
      if (enabled) inspect()
    },
    stop() {
      stop()
      current = undefined
      key = undefined
      monitor = null
    },
  }
}
