import { createContext, useContext } from 'react'
import type { Attachment, TurnFileChangesSummary } from '../../../../packages/chat-core/src/runtime'
import type { MobileWorkspaceFileTarget } from '@/domain/mobileFileTarget'
import type { MobileFileRequest } from '@/types/files'
import type { MobileWorkspaceChanges, WorkspaceGitSelection } from '@/types/workspaceGit'

export interface MobileFilePreviewActions {
  target: MobileWorkspaceFileTarget | null
  openBrowser: () => void
  openChangesBrowser: (selection?: WorkspaceGitSelection) => void
  loadChanges: (
    selection: WorkspaceGitSelection,
    signal?: AbortSignal
  ) => Promise<MobileWorkspaceChanges>
  openFile: (request: MobileFileRequest) => void
  openLink: (href: string) => void
  openWorkspaceFile: (path: string, lineStart?: number, lineEnd?: number) => void
  openAttachment: (attachment: Attachment) => void
  openChanges: (summary: TurnFileChangesSummary, path?: string) => void
}

export const FilePreviewContext = createContext<MobileFilePreviewActions | null>(null)
export const useMobileFilePreview = () => useContext(FilePreviewContext)
