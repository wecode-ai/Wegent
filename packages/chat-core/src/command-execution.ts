import type { WorkbenchProcessingBlock } from './workbench-message-reducer'

export interface CommandExecutionPayload {
  kind: 'command_execution'
  processId?: string | null
  status?: string | null
  exitCode?: number | null
  stdin?: string
}

export function commandExecutionPayload(
  block: WorkbenchProcessingBlock
): CommandExecutionPayload | null {
  if (block.type !== 'tool') return null
  const payload = block.renderPayload
  return payload &&
    typeof payload === 'object' &&
    'kind' in payload &&
    payload.kind === 'command_execution'
    ? (payload as CommandExecutionPayload)
    : null
}

export function mergeCommandExecutionPayload(previous: unknown, update: unknown): unknown {
  if (
    !previous ||
    typeof previous !== 'object' ||
    !('kind' in previous) ||
    previous.kind !== 'command_execution' ||
    !update ||
    typeof update !== 'object' ||
    !('kind' in update) ||
    update.kind !== 'command_execution'
  )
    return update
  return { ...previous, ...update }
}
