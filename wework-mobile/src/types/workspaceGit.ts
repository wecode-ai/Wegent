import type { DiffFileSection } from '../../../packages/collaboration/src/conversation/parseUnifiedDiff'
import type {
  WorkspaceGitDiffMode,
  WorkspaceGitSelection,
} from '../../../packages/chat-core/src/workspace-git'
import type { MobileWorkspaceFileTarget } from '@/domain/mobileFileTarget'

export type { WorkspaceGitDiffMode, WorkspaceGitSelection }

export interface MobileWorkspaceChangedFile extends DiffFileSection {
  additions: number
  deletions: number
  status: 'added' | 'deleted' | 'renamed' | 'modified'
}

export interface MobileWorkspaceChanges {
  target: MobileWorkspaceFileTarget
  selection: WorkspaceGitSelection
  branchName: string
  diff: string
  files: MobileWorkspaceChangedFile[]
  fileCount: number
  additions: number
  deletions: number
}
