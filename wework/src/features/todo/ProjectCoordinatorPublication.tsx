import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { DialogForm } from '@/components/common/DialogForm'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import type {
  CollaborationIssue,
  CollaborationProject,
  SharedWorkspaceApi,
} from '@wegent/collaboration'
import { canCommentCollaborationIssue } from '@wegent/collaboration'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { SelectField } from '@wegent/collaboration/controls/SelectField'
import { Textarea as ControlTextarea } from '@wegent/collaboration/controls/Textarea'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import type { Ref } from 'react'
import { useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react'
import type { StandInSettingsHandle } from './StandInSettingsPage'
import { useStandInPanelNavigation } from './useStandInPanelNavigation'

/** Publication writes only the explicitly entered text to an existing shared record. */
interface ProjectCoordinatorPublicationProps {
  api: SharedWorkspaceApi
  project: CollaborationProject
  onClose(): void
  onPublished(): void
  ref?: Ref<StandInSettingsHandle>
}

export function ProjectCoordinatorPublication(props: ProjectCoordinatorPublicationProps) {
  const { api, project } = props
  const scope = JSON.stringify([project.id, project.project_store, project.current_user_id])
  const [owner, setOwner] = useState({ api, scope, revision: 0 })
  if (owner.api !== api || owner.scope !== scope) {
    setOwner({ api, scope, revision: owner.revision + 1 })
  }
  return <ProjectCoordinatorPublicationContent key={owner.revision} {...props} />
}

function ProjectCoordinatorPublicationContent({
  api,
  project,
  onClose,
  onPublished,
  ref,
}: ProjectCoordinatorPublicationProps) {
  const { t } = useTranslation('common')
  const [selected, setSelected] = useState('')
  const [content, setContent] = useState('')
  const [published, setPublished] = useState<CollaborationIssue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [discard, setDiscard] = useState(false)
  const sending = useRef(false)
  const navigation = useStandInPanelNavigation(!!content.trim(), busy, () => setDiscard(true))
  const close = () => navigation.requestLeave(onClose)
  const dialogRef = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => ({ requestClose: close, requestLeave: navigation.requestLeave }))

  const createCandidates = (
    currentProject: CollaborationProject,
    initialData?: CollaborationIssue[]
  ) =>
    createAsyncResource(
      JSON.stringify([
        'project-coordinator-publication',
        currentProject.project_store,
        currentProject.id,
        currentProject.current_user_id,
      ]),
      async () => {
        const rows = await api.issues.list(currentProject.id)
        return rows.filter(
          issue =>
            String(issue.cloud_project_id) === String(currentProject.id) &&
            !issue.archived_at &&
            canCommentCollaborationIssue(currentProject, issue)
        )
      },
      { initialData }
    )
  const [query, setQuery] = useState(() => ({ project, resource: createCandidates(project) }))
  if (query.project !== project)
    setQuery({ project, resource: createCandidates(project, query.resource.getSnapshot().data) })
  const resource = query.resource
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot
  )
  const issues = snapshot.data ?? null
  const visibleError =
    error ?? (snapshot.status === 'error' ? getStandInErrorMessage(snapshot.error) : null)

  const publish = async () => {
    if (sending.current || !dialogRef.current?.isConnected || !selected || !content.trim()) return
    sending.current = true
    setBusy(true)
    setError(null)
    try {
      const [currentProject, issue] = await Promise.all([
        api.projects.get(project.id),
        api.issues.get(selected),
      ])
      if (!resource.hasSubscribers()) return
      if (
        String(issue.id) !== String(selected) ||
        String(currentProject.id) !== String(project.id) ||
        String(issue.cloud_project_id) !== String(project.id) ||
        issue.archived_at ||
        !canCommentCollaborationIssue(currentProject, issue)
      )
        throw new Error('permission_denied')
      await api.comments.create(issue.id, content.trim())
      if (!resource.hasSubscribers()) return
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
    <DialogSurface
      onClose={close}
      active={!discard}
      render={
        <div
          ref={dialogRef}
          className="min-h-0 flex-1 overflow-y-auto p-5"
          data-testid="project-coordinator-publication"
        />
      }
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
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="project-coordinator-publication-close"
            onClick={close}
            className="mt-4 min-h-11 md:min-h-8 rounded-md px-3 text-sm hover:bg-muted"
          >
            {t('standIn.project_coordinator.back_to_chat')}
          </ControlButton>
        </>
      ) : (
        <DialogForm
          className="mt-5 flex max-w-2xl flex-col gap-4"
          onSubmit={event => {
            event.preventDefault()
            void publish()
          }}
        >
          {issues === null && !visibleError && <p role="status">{t('standIn.loading')}</p>}
          {issues?.length === 0 && (
            <p className="text-sm text-text-muted">
              {t('standIn.project_coordinator.no_publish_target')}
            </p>
          )}
          <label className="flex flex-col gap-2 text-sm">
            {t('standIn.project_coordinator.publish_target')}
            <SelectField
              testId="project-coordinator-publication-target"
              menuTestId="project-coordinator-publication-target-options"
              accessibleLabel={t('standIn.project_coordinator.publish_target')}
              value={selected}
              onChange={setSelected}
              disabled={busy || !issues?.length}
              options={[
                { value: '', label: t('standIn.project_coordinator.choose_issue') },
                ...(issues ?? []).map(issue => ({ value: String(issue.id), label: issue.title })),
              ]}
            />
          </label>
          <label className="flex flex-col gap-2 text-sm">
            {t('standIn.project_coordinator.publish_content')}
            <ControlTextarea
              value={content}
              disabled={busy}
              onChange={event => setContent(event.target.value)}
              rows={7}
              data-testid="project-coordinator-publication-content"
              className="w-full resize-y rounded-md border border-border bg-background p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          {visibleError && (
            <p role="alert" className="text-sm text-error">
              {visibleError}
            </p>
          )}
          {issues === null && visibleError && (
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="project-coordinator-publication-reload"
              onClick={() => {
                setError(null)
                void resource.reload()
              }}
              className="min-h-11 md:min-h-8 self-start text-sm underline"
            >
              {t('standIn.reload')}
            </ControlButton>
          )}
          <div className="flex justify-end gap-2">
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="project-coordinator-publication-cancel"
              disabled={busy}
              onClick={close}
              className="min-h-11 md:min-h-8 rounded-md px-3 text-sm hover:bg-muted"
            >
              {t('standIn.cancel')}
            </ControlButton>
            <ControlButton
              variant="primary"
              size="sm"
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
            </ControlButton>
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
    </DialogSurface>
  )
}
