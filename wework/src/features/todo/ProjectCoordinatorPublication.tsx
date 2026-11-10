import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import {
  canCommentCollaborationIssue,
  type CollaborationIssue,
  type CollaborationProject,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { DialogForm } from '@/components/common/DialogForm'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { useStandInPanelNavigation } from './useStandInPanelNavigation'
import type { StandInSettingsHandle } from './StandInSettingsPage'

/** Publication writes only the explicitly entered text to an existing shared record. */
export function ProjectCoordinatorPublication({
  api,
  project,
  onClose,
  onPublished,
  ref,
}: {
  api: SharedWorkspaceApi
  project: CollaborationProject
  onClose(): void
  onPublished(): void
  ref?: Ref<StandInSettingsHandle>
}) {
  const { t } = useTranslation('common')
  const [issues, setIssues] = useState<CollaborationIssue[] | null>(null)
  const [selected, setSelected] = useState('')
  const [content, setContent] = useState('')
  const [published, setPublished] = useState<CollaborationIssue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  const [discard, setDiscard] = useState(false)
  const sending = useRef(false)
  const navigation = useStandInPanelNavigation(!!content.trim(), busy, () => setDiscard(true))
  const close = () => navigation.requestLeave(onClose)
  const dialogRef = useDialogKeyboard<HTMLDivElement>(close, !discard)
  useImperativeHandle(ref, () => ({ requestClose: close, requestLeave: navigation.requestLeave }))

  useEffect(() => {
    let active = true
    void api.issues
      .list(project.id)
      .then(rows => {
        if (!active) return
        setIssues(
          rows.filter(
            issue =>
              String(issue.cloud_project_id) === String(project.id) &&
              !issue.archived_at &&
              canCommentCollaborationIssue(project, issue)
          )
        )
        setError(null)
      })
      .catch(cause => {
        if (active) setError(getStandInErrorMessage(cause))
      })
    return () => {
      active = false
    }
  }, [api, project, retry])

  const publish = async () => {
    if (sending.current || !selected || !content.trim()) return
    sending.current = true
    setBusy(true)
    setError(null)
    try {
      const [currentProject, issue] = await Promise.all([
        api.projects.get(project.id),
        api.issues.get(selected),
      ])
      if (
        String(currentProject.id) !== String(project.id) ||
        String(issue.cloud_project_id) !== String(project.id) ||
        issue.archived_at ||
        !canCommentCollaborationIssue(currentProject, issue)
      )
        throw new Error('permission_denied')
      await api.comments.create(issue.id, content.trim())
      setPublished(issue)
      setContent('')
      onPublished()
    } catch (cause) {
      setError(getStandInErrorMessage(cause))
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  return (
    <div
      ref={dialogRef}
      className="min-h-0 flex-1 overflow-y-auto p-5"
      data-testid="project-coordinator-publication"
    >
      <h3 className="heading-sm">{t('standIn.project_coordinator.publish')}</h3>
      <p className="mt-2 text-sm text-text-muted">
        {t('standIn.project_coordinator.publish_help')}
      </p>
      {published ? (
        <>
          <p role="status" className="mt-5 text-sm" data-testid="project-coordinator-published">
            {t('standIn.project_coordinator.published', { issue: published.title })}
          </p>
          <button
            type="button"
            data-testid="project-coordinator-publication-close"
            onClick={close}
            className="mt-4 min-h-11 md:min-h-8 rounded-md px-3 text-sm hover:bg-muted"
          >
            {t('standIn.project_coordinator.back_to_chat')}
          </button>
        </>
      ) : (
        <DialogForm
          className="mt-5 flex max-w-2xl flex-col gap-4"
          onSubmit={event => {
            event.preventDefault()
            void publish()
          }}
        >
          {issues === null && !error && <p role="status">{t('standIn.loading')}</p>}
          {issues?.length === 0 && (
            <p className="text-sm text-text-muted">
              {t('standIn.project_coordinator.no_publish_target')}
            </p>
          )}
          <label className="flex flex-col gap-2 text-sm">
            {t('standIn.project_coordinator.publish_target')}
            <select
              value={selected}
              disabled={busy || !issues?.length}
              onChange={event => setSelected(event.target.value)}
              data-testid="project-coordinator-publication-target"
              className="min-h-11 md:min-h-9 rounded-md border border-border bg-background px-3"
            >
              <option value="">{t('standIn.project_coordinator.choose_issue')}</option>
              {issues?.map(issue => (
                <option key={issue.id} value={issue.id}>
                  {issue.title}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-2 text-sm">
            {t('standIn.project_coordinator.publish_content')}
            <textarea
              value={content}
              disabled={busy}
              onChange={event => setContent(event.target.value)}
              rows={7}
              data-testid="project-coordinator-publication-content"
              className="w-full resize-y rounded-md border border-border bg-background p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-error">
              {error}
            </p>
          )}
          {issues === null && error && (
            <button
              type="button"
              data-testid="project-coordinator-publication-reload"
              onClick={() => setRetry(value => value + 1)}
              className="min-h-11 md:min-h-8 self-start text-sm underline"
            >
              {t('standIn.reload')}
            </button>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              data-testid="project-coordinator-publication-cancel"
              disabled={busy}
              onClick={close}
              className="min-h-11 md:min-h-8 rounded-md px-3 text-sm hover:bg-muted"
            >
              {t('standIn.cancel')}
            </button>
            <button
              type="submit"
              data-testid="project-coordinator-publication-submit"
              disabled={busy || !selected || !content.trim()}
              className="min-h-11 md:min-h-8 rounded-md bg-text-primary px-3 text-sm text-background disabled:opacity-40"
            >
              {t(
                busy
                  ? 'standIn.project_coordinator.publishing'
                  : 'standIn.project_coordinator.publish'
              )}
            </button>
          </div>
        </DialogForm>
      )}
      <ConfirmDialog
        open={discard}
        destructive
        title={t('standIn.personal.discard_help')}
        description={t('standIn.personal.discard_description')}
        cancelLabel={t('standIn.personal.keep_editing')}
        confirmLabel={t('standIn.memory.discard')}
        confirmTestId="project-coordinator-publication-discard"
        cancelTestId="project-coordinator-publication-keep"
        onClose={() => {
          navigation.cancelLeave()
          setDiscard(false)
        }}
        onConfirm={() => {
          setDiscard(false)
          navigation.confirmLeave(onClose)
        }}
      />
    </div>
  )
}
