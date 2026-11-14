import { workspaceGitDiffCommand } from '../../../packages/chat-core/src/workspace-git'
import { mobileWorkspaceChangedFiles } from '@/domain/mobileWorkspaceGit'
import type { MobileWorkspaceFileTarget } from '@/domain/mobileFileTarget'
import type { MobileWorkspaceChanges, WorkspaceGitSelection } from '@/types/workspaceGit'
import type { RuntimeApi } from './runtimeApi'
import { throwIfAborted } from './mobileAbort'

type WorkspaceGitApi = Pick<
  RuntimeApi,
  'getWorkspaceGitBranch' | 'getWorkspaceGitDiff' | 'isWorkspaceGitRepository'
>

export class WorkspaceNotGitRepositoryError extends Error {
  constructor() {
    super('此目录不是 Git 仓库')
    this.name = 'WorkspaceNotGitRepositoryError'
  }
}

export async function loadMobileWorkspaceChanges(
  api: WorkspaceGitApi,
  target: MobileWorkspaceFileTarget,
  selection: WorkspaceGitSelection,
  signal?: AbortSignal
): Promise<MobileWorkspaceChanges> {
  throwIfAborted(signal)
  const normalized: WorkspaceGitSelection = { mode: selection.mode }
  workspaceGitDiffCommand(normalized)
  const [branchName, diff] = await readGitSnapshot(api, target, normalized, signal)
  throwIfAborted(signal)
  const files = mobileWorkspaceChangedFiles(diff)
  return {
    target: { ...target },
    selection: normalized,
    branchName,
    diff,
    files,
    fileCount: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  }
}

async function readGitSnapshot(
  api: WorkspaceGitApi,
  target: MobileWorkspaceFileTarget,
  selection: WorkspaceGitSelection,
  signal?: AbortSignal
): Promise<[string, string]> {
  try {
    return await Promise.all([
      api.getWorkspaceGitBranch(target.deviceId, target.path, signal),
      api.getWorkspaceGitDiff(target.deviceId, target.path, selection, signal),
    ])
  } catch (error) {
    throwIfAborted(signal)
    // Match PC environment loading: probe a failed Git read before classifying it as non-Git.
    let isGitRepository: boolean | undefined
    try {
      isGitRepository = await api.isWorkspaceGitRepository(target.deviceId, target.path, signal)
    } catch {
      throwIfAborted(signal)
      throw error
    }
    if (isGitRepository === false) throw new WorkspaceNotGitRepositoryError()
    throw error
  }
}
