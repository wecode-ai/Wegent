// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useState } from 'react'
import { type CollaborationIssue, type CollaborationProject } from '@wegent/collaboration'
import { toast } from 'sonner'

import { apiClient } from '@/apis/client'
import { createWebSharedWorkspaceApi } from '@/features/collaboration/shared-api'
import { useTranslation } from '@/hooks/useTranslation'

export interface SendToCollaborationDialogProps {
  taskId: number
  subtaskIds?: number[]
  open: boolean
  onOpenChange(open: boolean): void
}

export function SendToCollaborationDialog({
  taskId,
  subtaskIds,
  open,
  onOpenChange,
}: SendToCollaborationDialogProps) {
  const { t } = useTranslation('inbox')
  const api = useMemo(() => createWebSharedWorkspaceApi(apiClient), [])
  const [projects, setProjects] = useState<CollaborationProject[]>([])
  const [issues, setIssues] = useState<CollaborationIssue[]>([])
  const [projectId, setProjectId] = useState('')
  const [targetKind, setTargetKind] = useState<'new_issue' | 'existing_issue'>('new_issue')
  const [issueId, setIssueId] = useState('')
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    void api.projects
      .list()
      .then(items => {
        setProjects(items)
        setProjectId(current => current || items[0]?.id || '')
      })
      .catch(() => toast.error(t('collaboration.failed')))
  }, [api, open, t])

  useEffect(() => {
    if (!open || !projectId || targetKind !== 'existing_issue') return
    void api.issues
      .getBoardSnapshot(projectId)
      .then(snapshot => {
        setIssues(snapshot.items)
        setIssueId(current => current || snapshot.items[0]?.id || '')
      })
      .catch(() => toast.error(t('collaboration.failed')))
  }, [api, open, projectId, t, targetKind])

  if (!open) return null

  const canSubmit =
    Boolean(projectId) && (targetKind === 'new_issue' ? Boolean(title.trim()) : Boolean(issueId))

  const submit = async () => {
    if (!canSubmit) return
    setLoading(true)
    try {
      const response = await api.projects.importMessages(projectId, {
        sourceTaskId: taskId,
        subtaskIds,
        target:
          targetKind === 'new_issue'
            ? { kind: 'new_issue', title: title.trim() }
            : { kind: 'existing_issue', issueId },
        note: note.trim() || undefined,
      })
      toast.success(t('collaboration.success'))
      onOpenChange(false)
      window.location.href = `/collaboration/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(response.issue.id)}`
    } catch {
      toast.error(t('collaboration.failed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="collaboration-dialog-backdrop">
      <div
        className="collaboration-dialog"
        role="dialog"
        aria-modal="true"
        data-testid="send-to-collaboration-dialog"
      >
        <h2>{t('collaboration.title')}</h2>
        <div className="grid gap-4">
          <label className="grid gap-1.5">
            {t('collaboration.project')}
            <select
              data-testid="send-to-collaboration-project"
              value={projectId}
              onChange={event => {
                setProjectId(event.target.value)
                setIssueId('')
              }}
            >
              {projects.map(project => (
                <option value={project.id} key={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <div className="collaboration-form-row">
            <label>
              <input
                type="radio"
                name="collaboration-target"
                data-testid="send-to-collaboration-new-issue"
                checked={targetKind === 'new_issue'}
                onChange={() => setTargetKind('new_issue')}
              />
              {t('collaboration.new_issue')}
            </label>
            <label>
              <input
                type="radio"
                name="collaboration-target"
                data-testid="send-to-collaboration-existing-issue"
                checked={targetKind === 'existing_issue'}
                onChange={() => setTargetKind('existing_issue')}
              />
              {t('collaboration.existing_issue')}
            </label>
          </div>
          {targetKind === 'new_issue' ? (
            <label className="grid gap-1.5">
              {t('collaboration.issue_title')}
              <input
                data-testid="send-to-collaboration-title"
                value={title}
                onChange={event => setTitle(event.target.value)}
              />
            </label>
          ) : (
            <label className="grid gap-1.5">
              {t('collaboration.issue')}
              <select
                data-testid="send-to-collaboration-issue"
                value={issueId}
                onChange={event => setIssueId(event.target.value)}
              >
                {issues.map(issue => (
                  <option value={issue.id} key={issue.id}>
                    #{issue.sequence_number} {issue.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="grid gap-1.5">
            {t('collaboration.note')}
            <textarea
              data-testid="send-to-collaboration-note"
              value={note}
              onChange={event => setNote(event.target.value)}
            />
          </label>
        </div>
        <footer className="mt-5">
          <button
            type="button"
            data-testid="send-to-collaboration-cancel"
            onClick={() => onOpenChange(false)}
          >
            {t('collaboration.cancel')}
          </button>
          <button
            type="button"
            className="collaboration-primary-button"
            data-testid="send-to-collaboration-submit"
            disabled={!canSubmit || loading}
            onClick={() => void submit()}
          >
            {loading ? t('collaboration.sending') : t('collaboration.send')}
          </button>
        </footer>
      </div>
    </div>
  )
}
