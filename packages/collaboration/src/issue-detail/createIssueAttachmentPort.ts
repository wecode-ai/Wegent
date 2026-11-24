import type {
  IssueAttachmentContext,
  SharedWorkspaceAttachmentsApi,
} from '../ports/SharedWorkspaceApi'
import type { SharedIssueDetailPort } from './createSharedIssueDetailPort'

type AttachmentApi = Pick<
  SharedWorkspaceAttachmentsApi,
  'list' | 'upload' | 'read' | 'download' | 'remove'
>

export function createIssueAttachmentPort({
  api,
  saveFile,
  context,
}: {
  api?: AttachmentApi
  saveFile(blob: Blob, filename: string): Promise<unknown>
  context?: IssueAttachmentContext
}): SharedIssueDetailPort['attachments'] {
  const unavailable = async () => {
    throw new Error('Issue attachment access is unavailable')
  }
  const read = (attachmentId: string) =>
    api ? (context ? api.read(attachmentId, context) : api.read(attachmentId)) : unavailable()
  return {
    canUpload: Boolean(api),
    list: async issueId => (await api?.list(issueId)) ?? [],
    upload: api ? (issueId, file) => api.upload(issueId, file) : unavailable,
    read,
    async download(attachmentId, filename) {
      if (api?.download) {
        await (context
          ? api.download(attachmentId, filename, context)
          : api.download(attachmentId, filename))
      } else {
        await saveFile(await read(attachmentId), filename)
      }
    },
    remove: attachmentId =>
      api
        ? context
          ? api.remove(attachmentId, context)
          : api.remove(attachmentId)
        : unavailable(),
  }
}
