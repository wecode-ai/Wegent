import { createContext, useContext } from 'react'
import { fetchAttachmentBlob as fetchDefaultAttachmentBlob } from '@/api/attachments'

export type FetchAttachmentBlob = (attachmentId: number) => Promise<Blob>

export const AttachmentDownloadContext = createContext<FetchAttachmentBlob | null>(null)

export function useAttachmentDownload(): FetchAttachmentBlob {
  return useContext(AttachmentDownloadContext) ?? fetchDefaultAttachmentBlob
}
