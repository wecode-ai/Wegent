import {
  validateWorkspaceGitBaseRef,
  workspaceGitDiffCommand,
} from '../../../packages/chat-core/src/workspace-git'
import { mobileWorkspaceChangedFiles } from '@/domain/mobileWorkspaceGit'
import type { MobileWorkspaceFileTarget } from '@/domain/mobileFileTarget'
import type { MobileWorkspaceChanges, WorkspaceGitSelection } from '@/types/workspaceGit'
import type { RuntimeApi } from './runtimeApi'

type WorkspaceGitApi = Pick<
  RuntimeApi,
  'getWorkspaceGitBranch' | 'getWorkspaceGitDiff' | 'listWorkspaceGitBranches'
>

export async function loadMobileWorkspaceChanges(
  api: WorkspaceGitApi,
  target: MobileWorkspaceFileTarget,
  selection: WorkspaceGitSelection,
  signal?: AbortSignal
): Promise<MobileWorkspaceChanges> {
  signal?.throwIfAborted()
  const normalized: WorkspaceGitSelection =
    selection.mode === 'branch' && selection.baseRef !== undefined
      ? { mode: 'branch', baseRef: validateWorkspaceGitBaseRef(selection.baseRef) }
      : { ...selection }
  workspaceGitDiffCommand(normalized)
  const [branchName, diff] = await Promise.all([
    api.getWorkspaceGitBranch(target.deviceId, target.path, signal),
    api.getWorkspaceGitDiff(target.deviceId, target.path, normalized, signal),
  ])
  signal?.throwIfAborted()
  const files = mobileWorkspaceChangedFiles(diff)
  return {
    target: { ...target },
    selection: normalized,
    branchName,
    baseRef: normalized.baseRef,
    diff,
    files,
    fileCount: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  }
}

export function listMobileWorkspaceBranches(
  api: WorkspaceGitApi,
  target: MobileWorkspaceFileTarget,
  signal?: AbortSignal
): Promise<string[]> {
  return api.listWorkspaceGitBranches(target.deviceId, target.path, signal)
}
