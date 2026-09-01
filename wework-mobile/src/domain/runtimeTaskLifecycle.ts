import type {
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
} from '@/types/runtime'

const RUNNING_RUNTIME_EVENTS = new Set([
  'response.created',
  'response.in_progress',
  'runtime.task.started',
  'runtime.task.status',
])
const TERMINAL_RUNTIME_EVENTS = new Set([
  'response.completed',
  'response.failed',
  'response.incomplete',
  'error',
  'cancelled',
  'canceled',
  'runtime.task.completed',
  'runtime.task.failed',
  'runtime.task.cancelled',
  'runtime_task.completed',
  'runtime_task.failed',
  'runtime_task.cancelled',
  'runtime.tasks.completed',
  'runtime.tasks.failed',
  'runtime.tasks.cancelled',
])

export interface RuntimeSendTransition {
  key: string
  revision: number
  hadPreviousRunning: boolean
  previousRunning: boolean | undefined
}

export interface RuntimeTranscriptObservation {
  key: string
  lifecycleRevision: number
  requestId: number
}

export class RuntimeTaskLifecycleProjection {
  private readonly runningByTask = new Map<string, boolean>()
  private readonly revisionByTask = new Map<string, number>()
  private readonly transcriptRequestByTask = new Map<string, number>()

  snapshot(): ReadonlyMap<string, boolean> {
    return new Map(this.runningByTask)
  }

  executorStarted(address: RuntimeTaskAddress): boolean {
    const key = runtimeTaskKey(address)
    const changed = this.runningByTask.get(key) !== true
    this.advanceRevision(key)
    this.runningByTask.set(key, true)
    return changed
  }

  sendRequested(address: RuntimeTaskAddress): RuntimeSendTransition {
    const key = runtimeTaskKey(address)
    const transition = {
      key,
      revision: this.advanceRevision(key),
      hadPreviousRunning: this.runningByTask.has(key),
      previousRunning: this.runningByTask.get(key),
    }
    this.runningByTask.set(key, true)
    return transition
  }

  sendRejected(transition: RuntimeSendTransition): boolean {
    if (this.revisionByTask.get(transition.key) !== transition.revision) return false
    this.advanceRevision(transition.key)
    if (transition.hadPreviousRunning) {
      this.runningByTask.set(transition.key, transition.previousRunning ?? false)
    } else {
      this.runningByTask.delete(transition.key)
    }
    return true
  }

  renameSend(
    transition: RuntimeSendTransition,
    address: RuntimeTaskAddress
  ): RuntimeSendTransition {
    const nextKey = runtimeTaskKey(address)
    if (nextKey === transition.key) return transition

    const currentRevision = this.revisionByTask.get(transition.key) ?? 0
    const canRollback = currentRevision === transition.revision
    const currentRunning = this.runningByTask.get(transition.key)
    const hasCurrentRunning = this.runningByTask.has(transition.key)
    this.runningByTask.delete(transition.key)
    this.revisionByTask.delete(transition.key)
    this.transcriptRequestByTask.delete(transition.key)

    const nextRevision = this.advanceRevision(nextKey)
    if (hasCurrentRunning) this.runningByTask.set(nextKey, currentRunning ?? false)
    return {
      ...transition,
      key: nextKey,
      revision: canRollback ? nextRevision : -1,
    }
  }

  transcriptRequested(address: RuntimeTaskAddress): RuntimeTranscriptObservation {
    const key = runtimeTaskKey(address)
    const requestId = (this.transcriptRequestByTask.get(key) ?? 0) + 1
    this.transcriptRequestByTask.set(key, requestId)
    return {
      key,
      lifecycleRevision: this.revisionByTask.get(key) ?? 0,
      requestId,
    }
  }

  transcriptReceived(observation: RuntimeTranscriptObservation, running: boolean): boolean {
    if ((this.revisionByTask.get(observation.key) ?? 0) !== observation.lifecycleRevision) {
      return false
    }
    if (this.transcriptRequestByTask.get(observation.key) !== observation.requestId) return false

    const changed = this.runningByTask.get(observation.key) !== running
    this.runningByTask.set(observation.key, running)
    this.advanceRevision(observation.key)
    return changed
  }

  syncWork(work: RuntimeWorkListResponse): boolean {
    let changed = false
    for (const project of work.projects) {
      for (const workspace of project.deviceWorkspaces) {
        changed = this.syncWorkspace(workspace) || changed
      }
    }
    for (const workspace of work.chats) changed = this.syncWorkspace(workspace) || changed
    return changed
  }

  private syncWorkspace(workspace: RuntimeDeviceWorkspace): boolean {
    let changed = false
    for (const task of workspace.tasks) {
      if (typeof task.running !== 'boolean') continue
      const key = runtimeTaskKey({ deviceId: workspace.deviceId, taskId: task.taskId })
      if (this.runningByTask.get(key) !== task.running) continue
      changed = this.runningByTask.delete(key) || changed
    }
    return changed
  }

  private advanceRevision(key: string): number {
    const revision = (this.revisionByTask.get(key) ?? 0) + 1
    this.revisionByTask.set(key, revision)
    return revision
  }
}

export function runtimeTaskKey(address: Pick<RuntimeTaskAddress, 'deviceId' | 'taskId'>): string {
  return JSON.stringify([address.deviceId, address.taskId])
}

export function isRunningRuntimeEvent(name: string): boolean {
  return RUNNING_RUNTIME_EVENTS.has(name)
}

export function isTerminalRuntimeEvent(name: string): boolean {
  return TERMINAL_RUNTIME_EVENTS.has(name)
}

export function shouldReloadRuntimeWork(name: string, taskKnown: boolean): boolean {
  if (!taskKnown) return true
  return (
    name === 'runtime.task.title.updated' ||
    RUNNING_RUNTIME_EVENTS.has(name) ||
    TERMINAL_RUNTIME_EVENTS.has(name)
  )
}
