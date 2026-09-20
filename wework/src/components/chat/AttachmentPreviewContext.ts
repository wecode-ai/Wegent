import { createContext } from 'react'
import type { WorkspaceAttachmentPreviewSource } from '@/types/workspace-files'

export const AttachmentPreviewContext = createContext<
  ((source: WorkspaceAttachmentPreviewSource) => void) | null
>(null)
