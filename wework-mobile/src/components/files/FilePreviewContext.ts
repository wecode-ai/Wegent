import { createContext, useContext } from 'react'
import type { Attachment, TurnFileChangesSummary } from '../../../../packages/chat-core/src/runtime'
import type { MobileWorkspaceFileTarget } from '@/domain/mobileFileTarget'
import type { MobileFileRequest } from '@/types/files'

export interface MobileFilePreviewActions {
  target: MobileWorkspaceFileTarget | null
  openBrowser: () => void
  openFile: (request: MobileFileRequest) => void
  openLink: (href: string) => void
  openWorkspaceFile: (path: string, lineStart?: number, lineEnd?: number) => void
  openAttachment: (attachment: Attachment) => void
  openChanges: (summary: TurnFileChangesSummary, path?: string) => void
}

export const FilePreviewContext = createContext<MobileFilePreviewActions | null>(null)
export const useMobileFilePreview = () => useContext(FilePreviewContext)
