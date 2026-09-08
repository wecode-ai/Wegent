import type { ReactNode } from 'react'
import type { ReadWorkspaceFileChunk } from '@/lib/workspace-file-bytes'
import { WorkspaceFileReaderContext } from './WorkspaceFileReaderContext'

export function WorkspaceFileReaderProvider({
  children,
  readWorkspaceFileChunk,
}: {
  children: ReactNode
  readWorkspaceFileChunk?: ReadWorkspaceFileChunk
}) {
  return (
    <WorkspaceFileReaderContext.Provider value={readWorkspaceFileChunk ?? null}>
      {children}
    </WorkspaceFileReaderContext.Provider>
  )
}
