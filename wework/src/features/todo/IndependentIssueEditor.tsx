import { useEffect, useState, type ReactNode } from 'react'
import { Folder } from 'lucide-react'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import type { CloudProject } from '@/api/deliveries'
import { DialogForm } from '@/components/common/DialogForm'
import { useTranslation } from '@/hooks/useTranslation'
import {
  independentIssueInput,
  type IndependentIssue,
  type IndependentIssueInput,
  type PersonalIssuesApi,
} from '@/api/personalIssues'
import { IssueParticipantPicker } from './IssueParticipantPicker'
import { participantKey, resourceInvitations, type IssueParticipant } from './issueParticipants'

export interface IssueCreationInput extends IndependentIssueInput {
  project_id?: string
  project_status?: string
}
const control =
  'min-h-11 w-full rounded-md border border-border bg-background px-2 py-1 text-base text-text-primary md:min-h-8'

export function IndependentIssueEditor({
  api,
  collaborationApi,
  allowProjectSelection,
  issue,
  userId,
  busy,
  onSave,
  onCancel,
}: {
  api: PersonalIssuesApi
  collaborationApi?: SharedWorkspaceApi
  allowProjectSelection?: boolean
  issue: IndependentIssue | null
  userId: number
  busy: boolean
  onSave(input: IssueCreationInput): Promise<void>
  onCancel(): void
}) {
  const { t } = useTranslation('common')
  const canSelectProject = allowProjectSelection ?? !issue
  const [draft, setDraft] = useState<IndependentIssueInput>(() =>
    issue
      ? independentIssueInput(issue)
      : {
          title: '',
          description: '',
          status: 'pending',
          priority: 'medium',
          assignee_id: userId,
          participants: [],
          resource_participants: [],
          archived: false,
          due_at: null,
        }
  )
  const owner = issue?.creator_id ?? userId
  const [people, setPeople] = useState<IssueParticipant[]>(() => [
    {
      key: `human:${owner}`,
      kind: 'human',
      id: owner,
      name: owner === userId ? t('personalHome.me') : (issue?.people[owner] ?? `#${owner}`),
    },
    ...(issue?.metadata.direct_participants ?? issue?.metadata.participants ?? [])
      .filter(id => id !== owner)
      .map(id => ({
        key: `human:${id}`,
        kind: 'human' as const,
        id,
        name: issue?.people[id] ?? `#${id}`,
      })),
    ...(issue?.metadata.resource_participants ?? []).map(resource => ({
      key: participantKey(resource),
      kind: resource.kind,
      id: resource.id,
      name: resource.name,
    })),
  ])
  const [projectId, setProjectId] = useState('')
  const [projectStatus, setProjectStatus] = useState('')
  const [projects, setProjects] = useState<CloudProject[]>([])
  const [projectError, setProjectError] = useState('')
  const [revision, setRevision] = useState(0)
  const [loadingProjects, setLoadingProjects] = useState(canSelectProject)
  useEffect(() => {
    if (!canSelectProject) return
    let active = true
    void api
      .projects()
      .then(
        page => {
          if (active) {
            setProjects(
              page.items.filter(
                project =>
                  ['local', 'backend'].includes(project.task_provider) &&
                  project.access_role !== 'Viewer'
              )
            )
            setProjectError('')
          }
        },
        error => {
          if (active) setProjectError(error instanceof Error ? error.message : String(error))
        }
      )
      .finally(() => {
        if (active) setLoadingProjects(false)
      })
    return () => {
      active = false
    }
  }, [api, canSelectProject, revision])
  const project = projects.find(row => String(row.id) === projectId)
  const statuses = project?.board_config?.statuses ?? []
  const set = <K extends keyof IndependentIssueInput>(key: K, value: IndependentIssueInput[K]) =>
    setDraft(previous => ({ ...previous, [key]: value }))
  const changePeople = (next: IssueParticipant[]) => {
    setPeople(next)
    setDraft(previous => ({
      ...previous,
      participants: next
        .filter(person => person.kind === 'human' && person.id !== owner)
        .map(person => person.id),
      resource_participants: resourceInvitations(next),
      assignee_id:
        previous.assignee_id !== owner &&
        !next.some(person => person.kind === 'human' && person.id === previous.assignee_id)
          ? null
          : previous.assignee_id,
      assignee_resource:
        previous.assignee_resource &&
        !next.some(person => person.key === participantKey(previous.assignee_resource!))
          ? null
          : previous.assignee_resource,
    }))
  }
  const assignee = draft.assignee_resource
    ? participantKey(draft.assignee_resource)
    : draft.assignee_id
      ? `human:${draft.assignee_id}`
      : ''
  const field = (label: string, children: ReactNode) => (
    <label className="grid min-w-0 gap-1 text-sm">
      <span className="text-text-secondary">{label}</span>
      {children}
    </label>
  )
  return (
    <DialogForm
      className="flex min-w-0 flex-col gap-5"
      onSubmit={event => {
        event.preventDefault()
        void onSave({
          ...draft,
          ...(projectId ? { project_id: projectId, project_status: projectStatus } : {}),
        })
      }}
    >
      <fieldset disabled={busy} className="grid min-w-0 gap-5">
        {canSelectProject && (
          <div className="grid gap-1">
            <label className="flex items-center gap-2 text-sm">
              <Folder className="h-4 w-4 shrink-0 text-text-muted" />
              <span className="shrink-0 text-text-secondary">
                {t('issue_creation.project_label')}
              </span>
              <select
                data-testid="independent-issue-project"
                aria-label={t('issue_creation.project_label')}
                className={`${control} flex-1`}
                disabled={loadingProjects}
                value={projectId}
                onChange={event => {
                  setProjectId(event.target.value)
                  const target = projects.find(row => String(row.id) === event.target.value)
                  setProjectStatus(target?.board_config?.statuses[0]?.id ?? '')
                }}
              >
                <option value="">{t('issue_creation.independent_option')}</option>
                {projects.map(project => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-sm text-text-muted">
              {t(
                projectId
                  ? 'issue_creation.project_scope_hint'
                  : 'issue_creation.independent_scope_hint'
              )}
            </p>
            {projectError && (
              <p role="alert" className="text-sm text-error">
                {projectError}
                <button
                  type="button"
                  data-testid="issue-project-retry"
                  className="ml-2 underline"
                  onClick={() => {
                    setLoadingProjects(true)
                    setRevision(v => v + 1)
                  }}
                >
                  {t('independentIssues.retry')}
                </button>
              </p>
            )}
          </div>
        )}
        <label className="grid gap-1">
          <span className="sr-only">{t('independentIssues.title')}</span>
          <input
            autoFocus
            required
            maxLength={255}
            data-testid="independent-issue-title"
            aria-label={t('independentIssues.title')}
            placeholder={t('issue_creation.title_placeholder')}
            value={draft.title}
            onChange={event => set('title', event.target.value)}
            className="min-h-11 w-full border-0 bg-transparent text-heading-sm font-medium outline-none placeholder:text-text-muted md:min-h-8"
          />
        </label>
        <IssueParticipantPicker
          api={api}
          collaborationApi={collaborationApi}
          userId={userId}
          selected={people}
          onChange={changePeople}
          disabled={busy || owner !== userId}
        />
        <label className="grid gap-1">
          <span className="sr-only">{t('independentIssues.description')}</span>
          <textarea
            data-testid="independent-issue-description"
            aria-label={t('independentIssues.description')}
            placeholder={t('issue_creation.description_placeholder')}
            value={draft.description}
            onChange={event => set('description', event.target.value)}
            rows={6}
            className="w-full resize-y rounded-lg border border-border bg-background p-3 text-base leading-6 outline-none focus:border-primary"
          />
        </label>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {field(
            t('independentIssues.status'),
            projectId && statuses.length ? (
              <select
                data-testid="independent-issue-project-status"
                className={control}
                value={projectStatus}
                onChange={event => setProjectStatus(event.target.value)}
              >
                {statuses.map(status => (
                  <option key={status.id} value={status.id}>
                    {status.name}
                  </option>
                ))}
              </select>
            ) : (
              <select
                data-testid="independent-issue-status"
                className={control}
                value={draft.status}
                onChange={event => set('status', event.target.value as IndependentIssue['status'])}
              >
                {(['pending', 'in_progress', 'completed'] as const).map(status => (
                  <option key={status} value={status}>
                    {t(`independentIssues.${status}`)}
                  </option>
                ))}
              </select>
            )
          )}
          {field(
            t('independentIssues.priority'),
            <select
              data-testid="independent-issue-priority"
              className={control}
              value={draft.priority}
              onChange={event =>
                set('priority', event.target.value as IndependentIssue['priority'])
              }
            >
              {(['low', 'medium', 'high', 'urgent'] as const).map(priority => (
                <option key={priority} value={priority}>
                  {t(`independentIssues.${priority}`)}
                </option>
              ))}
            </select>
          )}
          {field(
            t('independentIssues.assignee'),
            <select
              data-testid="independent-issue-assignee"
              className={control}
              value={assignee}
              onChange={event => {
                const target = people.find(person => person.key === event.target.value)
                setDraft(previous => ({
                  ...previous,
                  assignee_id: target?.kind === 'human' ? target.id : null,
                  assignee_resource:
                    target && target.kind !== 'human' ? { kind: target.kind, id: target.id } : null,
                }))
              }}
            >
              <option value="">{t('independentIssues.unassigned')}</option>
              {people.map(person => (
                <option key={person.key} value={person.key}>
                  {person.name}
                </option>
              ))}
            </select>
          )}
          {field(
            t('independentIssues.due'),
            <input
              type="date"
              data-testid="independent-issue-due"
              className={control}
              value={draft.due_at ?? ''}
              onChange={event => set('due_at', event.target.value || null)}
            />
          )}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <span className="text-sm text-text-muted">
          {project?.name ?? t('issue_creation.independent_short')} ·{' '}
          {t('issue_creation.participant_count', { count: people.length })}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            data-testid="independent-issue-editor-cancel"
            onClick={onCancel}
            className="min-h-11 rounded-md px-3 text-sm hover:bg-muted md:min-h-8"
          >
            {t('independentIssues.cancel')}
          </button>
          <button
            type="submit"
            disabled={
              busy ||
              !draft.title.trim() ||
              (Boolean(projectId) && statuses.length > 0 && !projectStatus)
            }
            data-testid="independent-issue-save"
            className="min-h-11 rounded-md bg-text-primary px-4 text-sm text-background disabled:opacity-50 md:min-h-8"
          >
            {t(
              busy
                ? 'independentIssues.saving'
                : issue
                  ? 'independentIssues.save'
                  : 'issue_creation.create_issue'
            )}
          </button>
        </div>
      </div>
    </DialogForm>
  )
}
