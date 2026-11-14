import {
  getDiffStats,
  getDiffFileStatus,
  parseUnifiedDiff,
} from '../../../packages/collaboration/src/conversation/parseUnifiedDiff'
import type { MobileWorkspaceChangedFile } from '@/types/workspaceGit'

/** Use the same file boundaries, status and line counts as the PC review pane. */
export function mobileWorkspaceChangedFiles(diff: string): MobileWorkspaceChangedFile[] {
  return parseUnifiedDiff(diff).map(section => ({
    ...section,
    ...getDiffStats(section.lines),
    status: getDiffFileStatus(section),
  }))
}
