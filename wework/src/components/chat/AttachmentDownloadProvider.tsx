import type { ReactNode } from 'react'
import { AttachmentDownloadContext, type FetchAttachmentBlob } from './AttachmentDownloadContext'

export function AttachmentDownloadProvider({
  children,
  fetchAttachmentBlob,
}: {
  children: ReactNode
  fetchAttachmentBlob?: FetchAttachmentBlob
}) {
  return (
    <AttachmentDownloadContext.Provider value={fetchAttachmentBlob ?? null}>
      {children}
    </AttachmentDownloadContext.Provider>
  )
}
