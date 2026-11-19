import type { Attachment } from '@wegent/chat-core/runtime'
import type { ComposerAttachment } from '../issue-detail/ComposerAttachmentBadges'

export type IssueHomePendingFile = Attachment & ComposerAttachment & { id: number; file: File }

/** The draft owns its selected files and the lifetime of their local previews. */
export function createIssueHomeAttachmentDraft() {
  let files: IssueHomePendingFile[] = []
  let nextId = 0
  const listeners = new Set<() => void>()
  const publish = (next: IssueHomePendingFile[]) => {
    files = next
    listeners.forEach(listener => listener())
  }
  const release = (items: IssueHomePendingFile[]) => {
    for (const item of items) {
      if (item.local_preview_url) URL.revokeObjectURL(item.local_preview_url)
    }
  }
  const reset = () => {
    release(files)
    publish([])
  }
  return {
    getSnapshot: () => files,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (!listeners.size && files.length) reset()
        })
      }
    },
    add(input: File | File[]) {
      if (!listeners.size) return
      const batch = (Array.isArray(input) ? input : [input]).map(file => ({
        id: ++nextId,
        file,
        filename: file.name,
        mime_type: file.type,
        file_extension: file.name.includes('.') ? `.${file.name.split('.').pop()}` : '',
        file_size: file.size,
        status: 'ready' as const,
        created_at: new Date().toISOString(),
        local_preview_url: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
      }))
      publish([...files, ...batch])
    },
    remove(matches: (item: IssueHomePendingFile) => boolean) {
      const removed = files.filter(matches)
      if (!removed.length) return
      release(removed)
      const selected = new Set(removed)
      publish(files.filter(item => !selected.has(item)))
    },
    reset,
  }
}
