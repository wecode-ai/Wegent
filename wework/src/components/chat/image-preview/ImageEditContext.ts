import { createContext } from 'react'
import type { ImageComment, ImageEdit } from './imageEdit'

export interface SavedImageMarkup {
  attachmentId: number
  file: File
  comments: ImageComment[]
}

export interface ImageEditActions {
  scope?: string
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
