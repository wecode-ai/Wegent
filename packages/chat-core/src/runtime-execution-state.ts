import type { RuntimeExecutionState } from './runtime-task-api-types'

export function isRuntimeExecutionRunning(state: RuntimeExecutionState): boolean {
  return state.phase !== 'idle' && state.phase !== 'queued'
}

export function isNewerRuntimeExecutionState(
  previous: RuntimeExecutionState | undefined,
  incoming: RuntimeExecutionState
): boolean {
  return !previous || BigInt(incoming.revision) > BigInt(previous.revision)
}
