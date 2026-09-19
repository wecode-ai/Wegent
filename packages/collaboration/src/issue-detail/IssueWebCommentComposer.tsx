import { useIssueMentionGroups } from './useIssueMentionGroups'
import { useEffect, useRef, useState, type ComponentProps } from 'react'
import type { CollaborationTranslate } from '../i18n'
import type { ProjectChatMention } from '@wegent/chat-core'
import type { SharedWorkspaceAttachmentsApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationAgent, CollaborationComment, CollaborationMember } from '../types'
import type { AttachmentImageServices } from './AttachmentImageView'
import { ComposerAttachmentBadges } from './ComposerAttachmentBadges'
import { IssueMainCommentComposer } from './IssueMainCommentComposer'
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
  const [draft, setDraft] = useState('')
  const [mentions, setMentions] = useState<ProjectChatMention[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const active = useRef(true)
  const submitting = useRef(false)
  const selection = useIssueCommentAttachments(
    canAttach && attachmentApi ? file => attachmentApi.upload(issueId, file) : undefined,
    attachmentApi ? id => attachmentApi.remove(id) : undefined
  )
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const mentionGroups = useIssueMentionGroups(members, agents, translate)

  async function submit() {
    if (
      !canComment ||
      loading ||
      submitting.current ||
      !draft.trim() ||
      !selection.isAttachmentReadyToSend
    )
      return
    submitting.current = true
    setSending(true)
    setError(null)
    try {
      const comment = await send(
        issueCommentBody(draft.trim(), selection.attachments),
        ...(mentions.length ? [mentions] : [])
      )
      if (!active.current) return
      if (comment) onSent(comment)
      setDraft('')
      selection.resetAttachments()
    } catch (cause) {
      if (!active.current) return
      setError(cause instanceof Error ? cause.message : translate('todo.send_failed'))
      onError()
    } finally {
      submitting.current = false
      if (active.current) setSending(false)
    }
  }

  return (
    <IssueMainCommentComposer
      value={draft}
      onChange={setDraft}
      onSubmit={() => void submit()}
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
            showText: translate('todo.show_text_attachment'),
            appshot: translate('todo.appshot_attachment'),
          }}
        />
      }
      settings={settings}
      mentionGroups={mentionGroups}
      onMentionsChange={setMentions}
      testIds={{
        form: 'collaboration-issue-comment-form',
        input: 'collaboration-issue-comment',
        send: 'collaboration-issue-comment-submit',
        settings: 'collaboration-comment-settings-toggle',
        file: 'collaboration-comment-attach-input',
        attach: 'collaboration-comment-attach',
        mentions: 'collaboration-issue-mention-popup',
      }}
    />
  )
}
