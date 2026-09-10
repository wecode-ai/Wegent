// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState, type ChangeEvent } from 'react'

import type { CollaborationApi } from './api'
import { collaborationMessages } from './i18n'
import { collaborationTestIds } from './testIds'
import type {
  CollaborationAttachment,
  CollaborationAgent,
  CollaborationComment,
  CollaborationIssue,
  CollaborationMember,
  CollaborationPriority,
  CollaborationStatus,
} from './types'

type Messages = (typeof collaborationMessages)['zh-CN'] | (typeof collaborationMessages)['en']

interface IssueDetailProps {
  api: CollaborationApi
  issue: CollaborationIssue
  statuses: CollaborationStatus[]
  members: CollaborationMember[]
  agents: CollaborationAgent[]
  attachments: CollaborationAttachment[]
  comments: CollaborationComment[]
  messages: Messages
  onClose(): void
  onChange(issue: CollaborationIssue): void
  onAttachmentsChange(attachments: CollaborationAttachment[]): void
  onCommentsChange(comments: CollaborationComment[]): void
  onConflict(): Promise<void>
  onError(): void
}

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('status' in error)) return null
  return typeof error.status === 'number' ? error.status : null
}

export function IssueDetail({
  api,
  issue,
  statuses,
  members,
  agents,
  attachments,
  comments,
  messages,
  onClose,
  onChange,
  onAttachmentsChange,
  onCommentsChange,
  onConflict,
  onError,
}: IssueDetailProps) {
  const [draft, setDraft] = useState(issue)
  const [comment, setComment] = useState('')
  useEffect(() => setDraft(issue), [issue])

  const save = async () => {
    try {
      onChange(
        await api.updateIssue(issue.id, {
          version: issue.version,
          title: draft.title,
          description: draft.description,
          status: draft.status,
          priority: draft.priority,
          due_at: draft.due_at,
          tags: draft.tags,
          assignee_user_id: draft.assignee_user_id,
          assignee_agent_id: draft.assignee_agent_id,
          assignee_team_id: draft.assignee_team_id,
        })
      )
    } catch (error) {
      if (errorStatus(error) === 409) await onConflict()
      else onError()
    }
  }

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      const attachment = await api.addAttachment(issue.id, file)
      onAttachmentsChange([...attachments, attachment])
      event.target.value = ''
    } catch {
      onError()
    }
  }

  return (
    <div className="collaboration-detail-backdrop">
      <aside className="collaboration-issue-detail" data-testid={collaborationTestIds.issueDetail}>
        <header>
          <strong>#{issue.sequence_number}</strong>
          <button
            type="button"
            data-testid={collaborationTestIds.issueClose}
            aria-label={messages.close}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <label>
          {messages.issueTitle}
          <input
            value={draft.title}
            data-testid="collaboration-issue-detail-title"
            onChange={event => setDraft(current => ({ ...current, title: event.target.value }))}
          />
        </label>
        <label>
          {messages.issueDescription}
          <textarea
            data-testid="collaboration-issue-detail-description"
            value={draft.description}
            onChange={event =>
              setDraft(current => ({
                ...current,
                description: event.target.value,
              }))
            }
          />
        </label>
        <div className="collaboration-form-row">
          <label>
            {messages.issueStatus}
            <select
              data-testid="collaboration-issue-detail-status"
              value={draft.status}
              onChange={event =>
                setDraft(current => ({
                  ...current,
                  status: event.target.value,
                }))
              }
            >
              {statuses.map(status => (
                <option key={status.id} value={status.id}>
                  {status.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {messages.issuePriority}
            <select
              data-testid="collaboration-issue-detail-priority"
              value={draft.priority}
              onChange={event =>
                setDraft(current => ({
                  ...current,
                  priority: event.target.value as CollaborationPriority,
                }))
              }
            >
              {['none', 'low', 'medium', 'high', 'urgent'].map(value => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          {messages.showAssignee}
          <select
            data-testid="collaboration-issue-detail-assignee"
            value={
              draft.assignee_agent_id
                ? `agent:${draft.assignee_agent_id}`
                : draft.assignee_user_id
                  ? `user:${draft.assignee_user_id}`
                  : ''
            }
            onChange={event => {
              const [kind, id] = event.target.value.split(':')
              if (kind === 'agent') {
                const agent = agents.find(item => (item.agent_id ?? item.id) === id)
                setDraft(current => ({
                  ...current,
                  assignee_user_id: null,
                  assignee_agent_id: id,
                  assignee_agent_name: agent?.name ?? null,
                  assignee_team_id: null,
                }))
              } else if (kind === 'user') {
                const userId = Number(id)
                const member = members.find(item => item.user_id === userId)
                setDraft(current => ({
                  ...current,
                  assignee_user_id: userId,
                  assignee_name: member?.user_name ?? null,
                  assignee_agent_id: null,
                  assignee_team_id: null,
                }))
              } else {
                setDraft(current => ({
                  ...current,
                  assignee_user_id: null,
                  assignee_agent_id: null,
                  assignee_team_id: null,
                }))
              }
            }}
          >
            <option value="">{messages.unassigned}</option>
            {members.map(member => (
              <option value={`user:${member.user_id}`} key={`user:${member.user_id}`}>
                {member.user_name}
              </option>
            ))}
            {agents.map(agent => (
              <option value={`agent:${agent.agent_id ?? agent.id}`} key={`agent:${agent.id}`}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {messages.issueDueDate}
          <input
            type="datetime-local"
            data-testid="collaboration-issue-detail-due-at"
            value={draft.due_at?.slice(0, 16) ?? ''}
            onChange={event =>
              setDraft(current => ({
                ...current,
                due_at: event.target.value ? new Date(event.target.value).toISOString() : null,
              }))
            }
          />
        </label>
        <label>
          {messages.issueTags}
          <input
            data-testid="collaboration-issue-detail-tags"
            value={draft.tags.join(', ')}
            onChange={event =>
              setDraft(current => ({
                ...current,
                tags: event.target.value
                  .split(',')
                  .map(tag => tag.trim())
                  .filter(Boolean),
              }))
            }
          />
        </label>
        <section className="collaboration-attachments">
          <label className="collaboration-file-button">
            {messages.uploadAttachment}
            <input
              type="file"
              data-testid="collaboration-issue-attachment-upload"
              onChange={upload}
            />
          </label>
          {attachments.map(attachment => (
            <div key={attachment.id}>
              <span>{attachment.display_name}</span>
              <button
                type="button"
                data-testid={`collaboration-attachment-${attachment.id}-delete`}
                onClick={async () => {
                  try {
                    await api.deleteAttachment(attachment.id)
                    onAttachmentsChange(attachments.filter(item => item.id !== attachment.id))
                  } catch {
                    onError()
                  }
                }}
              >
                ×
              </button>
            </div>
          ))}
        </section>
        <section className="collaboration-comment">
          {comments.length > 0 && (
            <div className="collaboration-comment-list" data-testid="collaboration-comments">
              {comments.map(item => (
                <article key={item.id}>
                  <strong>{item.author}</strong>
                  <p>{item.body}</p>
                </article>
              ))}
            </div>
          )}
          <label>
            {messages.comment}
            <textarea
              data-testid={collaborationTestIds.issueComment}
              placeholder={messages.commentPlaceholder}
              value={comment}
              onChange={event => setComment(event.target.value)}
            />
          </label>
          <button
            type="button"
            data-testid={collaborationTestIds.issueCommentSubmit}
            disabled={!comment.trim()}
            onClick={async () => {
              try {
                const created = await api.addComment(issue.id, comment.trim())
                onCommentsChange([...comments, created])
                setComment('')
              } catch {
                onError()
              }
            }}
          >
            {messages.comment}
          </button>
        </section>
        <footer>
          <button
            type="button"
            className="collaboration-primary-button"
            data-testid={collaborationTestIds.issueSave}
            onClick={() => void save()}
          >
            {messages.save}
          </button>
        </footer>
      </aside>
    </div>
  )
}
