import { createContext } from 'react'
import type { ImageEdit } from './imageEdit'

export interface SavedImageMarkup {
  attachmentId: number
  file: File
}

export interface ImageEditActions {
  scope?: string
  current?: () => ImageEditActions | null
  saveMarkup?(
    attachmentId: number,
    loadFile: () => Promise<File>,
    edit: Extract<ImageEdit, { kind: 'markup' }>,
    signal: AbortSignal
  ): Promise<SavedImageMarkup | null>
  submit(
    source: {
      name: string
      mimeType: string
      loadFile(): Promise<File>
      draftAttachmentId?: number
    },
    edit: ImageEdit
  ): Promise<boolean>
}

export const ImageEditContext = createContext<ImageEditActions | null>(null)
