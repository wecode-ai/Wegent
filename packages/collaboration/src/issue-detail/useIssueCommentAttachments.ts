import { useState, useSyncExternalStore } from 'react'
import type { CollaborationAttachment } from '../types'
import type { IssueReplyAttachments } from './IssueThreadReplyComposer'
import {
  createIssueCommentAttachmentSelection,
  type IssueCommentAttachment,
} from './issueCommentAttachmentSelection'
export type { IssueCommentAttachment } from './issueCommentAttachmentSelection'

/** Keep files separate from the draft until the comment is successfully sent. */
export function useIssueCommentAttachments(
  upload: ((file: File) => Promise<CollaborationAttachment>) | undefined,
  remove: ((id: string) => Promise<void>) | undefined,
  scope?: unknown
): IssueReplyAttachments<IssueCommentAttachment> {
  const [owner, setOwner] = useState(() => ({
    scope,
    selection: createIssueCommentAttachmentSelection(),
  }))
  if (!Object.is(owner.scope, scope))
    setOwner({ scope, selection: createIssueCommentAttachmentSelection() })
  const selection = owner.selection
  const snapshot = useSyncExternalStore(
    selection.subscribe,
    selection.getSnapshot,
    selection.getSnapshot
  )
  return {
    ...snapshot,
    isAttachmentReadyToSend: snapshot.uploadingFiles.size === 0,
    handleFileSelect: files => selection.select(files, upload),
    removeAttachment: id => selection.remove(id, remove),
    resetAttachments: selection.reset,
  }
}

export function issueCommentBody(text: string, attachments: CollaborationAttachment[]) {
  return [
    text,
    ...attachments.map(
      attachment =>
        attachment.markdown ??
        `[${attachment.display_name.replace(/\]/g, '\\]')}](${attachment.markdown_url})`
    ),
  ].join('\n\n')
}
