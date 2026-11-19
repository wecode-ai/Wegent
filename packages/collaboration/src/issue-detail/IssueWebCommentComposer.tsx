import { useIssueMentionCandidates } from './useIssueMentionCandidates'
import { createWebCommentDraft } from './webCommentDraft'
import { useState, useSyncExternalStore, type ComponentProps } from 'react'
import type { CollaborationTranslate } from '../i18n'
import type { ProjectChatMention } from '@wegent/chat-core'
import type { SharedWorkspaceAttachmentsApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationAgent, CollaborationComment, CollaborationMember } from '../types'
import type { AttachmentImageServices } from './AttachmentImageView'
import { ComposerAttachmentBadges } from './ComposerAttachmentBadges'
import { IssueMainCommentComposer } from './IssueMainCommentComposer'
import type { IssueMentionOption } from './issueCommentMentions'
import {
  issueCommentBody,
  useIssueCommentAttachments,
  type IssueCommentAttachment,
} from './useIssueCommentAttachments'

const imageServices: AttachmentImageServices<IssueCommentAttachment> = {
  identity: attachment => attachment.id,
  async load(attachment) {
    const url = URL.createObjectURL(attachment.sourceFile)
    return { url, release: () => URL.revokeObjectURL(url) }
  },
  async download(_attachment, url, filename) {
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.rel = 'noopener'
    document.body.append(link)
    link.click()
    link.remove()
  },
}

/** Web persistence adapter for the same composer and attachment UI used by desktop. */
export function IssueWebCommentComposer({
  issueActions,
  assignment,
  issueId,
  attachmentApi,
  canComment,
  canAttach,
  loading,
  members,
  agents,
  translate,
  send,
  onSent,
  onError,
  settings,
}: {
  issueActions?: import('./issueCommentActions').CommentIssueActions
  assignment?: import('./useCommentAssignment').CommentAssignment
  issueId: string
  attachmentApi?: SharedWorkspaceAttachmentsApi
  canComment: boolean
  canAttach: boolean
  loading: boolean
  members: CollaborationMember[]
  agents: CollaborationAgent[]
  translate: CollaborationTranslate
  send(body: string, mentions?: ProjectChatMention[]): Promise<CollaborationComment | void>
  onSent(comment: CollaborationComment): void
  onError(): void
  settings?: ComponentProps<typeof IssueMainCommentComposer>['settings']
}) {
  const [owner, setOwner] = useState(() => ({
    issueId,
    attachmentApi,
    draft: createWebCommentDraft(),
    version: 0,
  }))
  if (owner.issueId !== issueId || owner.attachmentApi !== attachmentApi)
    setOwner({ issueId, attachmentApi, draft: createWebCommentDraft(), version: owner.version + 1 })
  const state = useSyncExternalStore(
    owner.draft.subscribe,
    owner.draft.getSnapshot,
    owner.draft.getSnapshot
  )
  const { draft, sending, failure } = state
  const error = failure
    ? failure.cause instanceof Error
      ? failure.cause.message
      : translate('todo.send_failed')
    : null
  const selection = useIssueCommentAttachments(
    canAttach && attachmentApi ? file => attachmentApi.upload(issueId, file) : undefined,
    attachmentApi ? id => attachmentApi.remove(id) : undefined,
    owner.draft
  )
  const mentionCandidates = useIssueMentionCandidates(members, agents, translate)

  async function submit(
    body: string,
    mentions: IssueMentionOption[],
    submission?: { commentOnly?: boolean }
  ) {
    if (!canComment || loading || !body || !selection.isAttachmentReadyToSend) return false
    return owner.draft.submit({
      body: issueCommentBody(body, selection.attachments),
      mentions: mentions.length
        ? submission?.commentOnly
          ? mentions.filter(mention => mention.type === 'user')
          : mentions
        : undefined,
      send,
      onSent,
      onError,
      resetAttachments: selection.resetAttachments,
    })
  }

  return (
    <IssueMainCommentComposer
      key={owner.version}
      issueActions={issueActions}
      assignment={assignment}
      value={draft}
      onChange={owner.draft.setDraft}
      onSubmit={submit}
      disabled={!canComment || loading}
      sending={sending}
      uploading={!selection.isAttachmentReadyToSend}
      error={error}
      labels={{
        placeholder: translate('todo.comment_placeholder'),
        send: translate('todo.send_message'),
        attach: translate('todo.attach_file'),
        settings: translate('todo.execution_settings'),
      }}
      onSelectFiles={canAttach && attachmentApi ? selection.handleFileSelect : undefined}
      attachments={
        <ComposerAttachmentBadges
          attachments={selection.attachments}
          uploadingFiles={selection.uploadingFiles}
          errors={selection.errors}
          onRemoveAttachment={id => void selection.removeAttachment(id)}
          imageServices={imageServices}
          labels={{
            removeAttachment: translate('todo.remove_attachment'),
            showText: translate('todo.show_text_attachment'),
            addingText: translate('todo.adding_pasted_text_attachment'),
            pastedText: translate('todo.pasted_text_attachment'),
            appshot: translate('todo.appshot_attachment'),
          }}
        />
      }
      settings={settings}
      mentionCandidates={mentionCandidates}
      translate={translate}
      testIds={{
        form: 'collaboration-issue-comment-form',
        input: 'collaboration-issue-comment',
        send: 'collaboration-issue-comment-submit',
        settings: 'collaboration-comment-settings-toggle',
        file: 'collaboration-comment-attach-input',
        attach: 'collaboration-comment-attach',
      }}
    />
  )
}
