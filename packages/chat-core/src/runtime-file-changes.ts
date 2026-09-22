import type { RuntimeTaskAddress, TurnFileChangesSummary } from './runtime'
import { normalizeTurnFileChanges } from './turn-file-changes'

export interface RuntimeFileReviewCommand {
  command_key: string
  path: string
  args: string[]
  timeout_seconds: number
  max_output_bytes: number
}
export interface RuntimeFileReviewResult {
  success: boolean
  stdout: unknown
  stderr?: string
  error?: string | null
}
export interface RuntimeFileChangesRevertRequest {
  address: RuntimeTaskAddress
  fileChanges: TurnFileChangesSummary
}
export interface RuntimeFileChangesRevertResponse {
  fileChanges: TurnFileChangesSummary
  file_changes?: TurnFileChangesSummary
}
export interface RuntimeFileChangesPort {
  executeCommand(
    deviceId: string,
    request: RuntimeFileReviewCommand
  ): Promise<RuntimeFileReviewResult>
  revertRuntimeFileChanges(
    request: RuntimeFileChangesRevertRequest
  ): Promise<RuntimeFileChangesRevertResponse>
  errorFileChanges(cause: unknown): unknown
}

/** Runtime artifacts retain their own device and workspace even when the active pane changes. */
export async function loadRuntimeFileChangesDiff(
  port: Pick<RuntimeFileChangesPort, 'executeCommand'>,
  artifact: TurnFileChangesSummary | undefined
): Promise<string> {
  if (!artifact) throw new Error('Runtime file changes artifact is unavailable')
  if (artifact.diff) return artifact.diff
  const response = await port.executeCommand(artifact.device_id, {
    command_key: 'turn_file_changes_review',
    path: artifact.workspace_path,
    args: [artifact.artifact_id],
    timeout_seconds: 30,
    max_output_bytes: 5 * 1024 * 1024,
  })
  const stdout =
    typeof response.stdout === 'object' && response.stdout !== null
      ? (response.stdout as Record<string, unknown>)
      : null
  if (!response.success || !stdout || stdout.success !== true || typeof stdout.diff !== 'string') {
    throw new Error(
      String(stdout?.error || response.error || response.stderr || 'File changes review failed')
    )
  }
  return stdout.diff
}

/** Explicit conflict results are durable artifact states, not successful silent retries. */
export async function revertRuntimeFileChanges(
  port: Pick<RuntimeFileChangesPort, 'revertRuntimeFileChanges' | 'errorFileChanges'>,
  address: RuntimeTaskAddress,
  artifact: TurnFileChangesSummary | undefined
): Promise<TurnFileChangesSummary> {
  if (!artifact) throw new Error('Runtime file changes artifact is unavailable')
  let updated: TurnFileChangesSummary | undefined
  try {
    const response = await port.revertRuntimeFileChanges({ address, fileChanges: artifact })
    updated = normalizeTurnFileChanges(response.fileChanges ?? response.file_changes)
    if (!updated) throw new Error('Invalid file changes response')
  } catch (cause) {
    updated = normalizeTurnFileChanges(port.errorFileChanges(cause))
    if (!updated) throw cause
  }
  return { ...updated, diff: artifact.diff, revertible: artifact.revertible ?? true }
}
