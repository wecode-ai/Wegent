import { normalizedFileExtension, readTextAttachmentMetadata } from './attachmentPresentation'
import type { ComposerAttachment } from './ComposerAttachmentBadges'
import type { CollaborationAttachment } from '../types'

export type IssueCommentAttachment = CollaborationAttachment &
  ComposerAttachment & { sourceFile: File }
interface SelectionSnapshot {
  attachments: IssueCommentAttachment[]
  uploadingFiles: Map<string, { file: File }>
  errors: Map<string, string>
}
const emptySelection = (): SelectionSnapshot => ({
  attachments: [],
  uploadingFiles: new Map(),
  errors: new Map(),
})
const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** Pending files belong to one draft generation; reset and detach invalidate its completions. */
export function createIssueCommentAttachmentSelection() {
  let snapshot = emptySelection()
  let revision = 0
  let nextId = 0
  const listeners = new Set<() => void>()
  const publish = (next: SelectionSnapshot) => {
    snapshot = next
    listeners.forEach(listener => listener())
  }
  const active = (request: number) => request === revision && listeners.size > 0
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        revision++
        snapshot = { ...snapshot, uploadingFiles: new Map() }
      }
    },
    async select(
      files: File[],
      upload: ((file: File) => Promise<CollaborationAttachment>) | undefined
    ) {
      if (!upload) throw new Error('Issue attachment upload is unavailable')
      const request = revision
      if (!active(request)) return
      const pending = files.map(file => ({
        file,
        key: `${++nextId}:${file.name}`,
      }))
      publish({
        ...snapshot,
        uploadingFiles: new Map([
          ...snapshot.uploadingFiles,
          ...pending.map(({ key, file }) => [key, { file }] as const),
        ]),
      })
      for (const { file, key } of pending) {
        if (!active(request)) return
        try {
          const attachment = await upload(file)
          if (!active(request)) return
          const textMetadata = await readTextAttachmentMetadata(file)
          if (!active(request)) return
          publish({
            ...snapshot,
            attachments: [
              ...snapshot.attachments,
              {
                ...attachment,
                filename: attachment.display_name,
                sourceFile: file,
                mime_type: attachment.content_type || file.type || 'application/octet-stream',
                file_extension: normalizedFileExtension(file.name),
                ...textMetadata,
              },
            ],
          })
        } catch (cause) {
          if (active(request))
            publish({
              ...snapshot,
              errors: new Map(snapshot.errors).set(key, errorMessage(cause)),
            })
        } finally {
          if (active(request)) {
            const uploadingFiles = new Map(snapshot.uploadingFiles)
            uploadingFiles.delete(key)
            publish({ ...snapshot, uploadingFiles })
          }
        }
      }
    },
    async remove(id: string, remove: ((id: string) => Promise<void>) | undefined) {
      if (!remove) throw new Error('Issue attachment removal is unavailable')
      const request = revision
      if (!active(request)) return
      try {
        await remove(id)
        if (!active(request)) return
        const errors = new Map(snapshot.errors)
        errors.delete(id)
        publish({
          ...snapshot,
          attachments: snapshot.attachments.filter(attachment => attachment.id !== id),
          errors,
        })
      } catch (cause) {
        if (active(request))
          publish({
            ...snapshot,
            errors: new Map(snapshot.errors).set(id, errorMessage(cause)),
          })
      }
    },
    reset() {
      revision++
      publish(emptySelection())
    },
  }
}
