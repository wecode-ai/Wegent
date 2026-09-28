import { describe, expect, it, vi } from 'vitest'
import type { TurnFileChangesSummary } from './runtime'
import { loadRuntimeFileChangesDiff, revertRuntimeFileChanges } from './runtime-file-changes'

const artifact: TurnFileChangesSummary = {
  version: 1,
  status: 'active',
  artifact_id: 'artifact-1',
  device_id: 'artifact-device',
  workspace_path: '/original/repo',
  file_count: 1,
  additions: 1,
  deletions: 0,
  files: [{ path: 'a.ts', change_type: 'created', additions: 1, deletions: 0, binary: false }],
}
const address = { deviceId: 'artifact-device', taskId: 'original-task' }

describe('shared PC runtime file actions', () => {
  it('uses the artifact address and command contract to load the real diff', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      success: true,
      stdout: { success: true, diff: 'diff --git a/a.ts b/a.ts' },
    })
    expect(await loadRuntimeFileChangesDiff({ executeCommand }, artifact)).toBe(
      'diff --git a/a.ts b/a.ts'
    )
    expect(executeCommand).toHaveBeenCalledWith(artifact.device_id, {
      command_key: 'turn_file_changes_review',
      path: artifact.workspace_path,
      args: [artifact.artifact_id],
      timeout_seconds: 30,
      max_output_bytes: 5 * 1024 * 1024,
    })
  })
  it('reuses an available diff without issuing a command', async () => {
    const executeCommand = vi.fn()
    expect(
      await loadRuntimeFileChangesDiff({ executeCommand }, { ...artifact, diff: 'existing diff' })
    ).toBe('existing diff')
    expect(executeCommand).not.toHaveBeenCalled()
  })
  it('rejects unavailable artifacts and structured command failures', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValue({ success: true, stdout: { success: false, error: 'Artifact expired' } })
    await expect(loadRuntimeFileChangesDiff({ executeCommand }, undefined)).rejects.toThrow(
      'artifact is unavailable'
    )
    await expect(loadRuntimeFileChangesDiff({ executeCommand }, artifact)).rejects.toThrow(
      'Artifact expired'
    )
  })
  it('preserves diff evidence when the runtime confirms a revert', async () => {
    const revert = vi.fn().mockResolvedValue({ fileChanges: { ...artifact, status: 'reverted' } })
    const original = { ...artifact, diff: 'original diff', revertible: false }
    const result = await revertRuntimeFileChanges(
      { revertRuntimeFileChanges: revert, errorFileChanges: () => undefined },
      address,
      original
    )
    expect(revert).toHaveBeenCalledWith({ address, fileChanges: original })
    expect(result).toMatchObject({ status: 'reverted', diff: 'original diff', revertible: false })
  })
  it('returns explicit conflict state from a rejected request without silently marking it reverted', async () => {
    const failure = new Error('Working tree changed')
    const revert = vi.fn().mockRejectedValue(failure)
    const details = vi.fn().mockReturnValue({ ...artifact, status: 'conflicted' })
    const result = await revertRuntimeFileChanges(
      { revertRuntimeFileChanges: revert, errorFileChanges: details },
      address,
      artifact
    )
    expect(details).toHaveBeenCalledWith(failure)
    expect(result.status).toBe('conflicted')
    expect(revert).toHaveBeenCalledOnce()
  })
  it('propagates transport failures and invalid success payloads', async () => {
    const revert = vi
      .fn()
      .mockRejectedValueOnce(new Error('Device offline'))
      .mockResolvedValueOnce({ fileChanges: { status: 'reverted' } })
    const port = { revertRuntimeFileChanges: revert, errorFileChanges: () => undefined }
    await expect(revertRuntimeFileChanges(port, address, artifact)).rejects.toThrow(
      'Device offline'
    )
    await expect(revertRuntimeFileChanges(port, address, artifact)).rejects.toThrow(
      'Invalid file changes response'
    )
  })
})
