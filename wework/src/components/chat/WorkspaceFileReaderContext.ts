import { createContext, useContext } from 'react'
import type { ReadWorkspaceFileChunk } from '@/lib/workspace-file-bytes'

export const WorkspaceFileReaderContext = createContext<ReadWorkspaceFileChunk | null>(null)

export function useWorkspaceFileReader(): ReadWorkspaceFileChunk | null {
  return useContext(WorkspaceFileReaderContext)
}
