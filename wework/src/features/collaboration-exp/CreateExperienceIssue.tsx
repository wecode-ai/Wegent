import { useMemo, useState, useSyncExternalStore } from 'react'
import { createAsyncResource, subscribeIdleResource } from '@wegent/chat-core/async-resource'
import {
  createExperienceIssueSubmission,
  selectableExperienceIssueMember,
} from './createExperienceIssueSubmission'
import { ChevronDown, Loader2, ShieldCheck, Target, X } from 'lucide-react'
import { canAssignCollaborationIssue, IssueDetailSearchableSelect } from '@wegent/collaboration'
import type {
  CollaborationIssue,
  CollaborationProject,
  ProjectAssistantRosterEntry,
} from '@wegent/collaboration'
import { DEFAULT_WORK_ITEM_PROJECT_ID, isDefaultWorkItemProject } from '@/api/deliveries'
import { DialogForm } from '@/components/common/DialogForm'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { useTranslation } from '@/hooks/useTranslation'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { workbenchOwnershipKey } from '@/features/workbench/workbenchOwnership'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import type { ExperienceProjectData, ExperienceProjectScope } from './model'
import type { ExperienceSource } from './data/useExperienceSources'
import './CreateExperienceIssue.css'

export interface CreateExperienceIssueProps {
  active: boolean
  sources: ExperienceSource[]
  projects: readonly ExperienceProjectData[]
  onClose(): void
  onCreated(scope: ExperienceProjectScope, issue: CollaborationIssue): void
}

function tomorrowDate() {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const projectKey = (project: CollaborationProject) =>
  JSON.stringify([project.project_store, project.id])
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

export function CreateExperienceIssue(props: CreateExperienceIssueProps) {
  const { state, services } = useWorkbench()
  const connection = useOptionalCloudConnection()
  const ownerKey = workbenchOwnershipKey(connection, state.user)
  if (!props.active || !state.user) return null
  return (
    <CreateIssueForm
      key={ownerKey}
      {...props}
      viewerId={Number(state.user.id)}
      viewerName={state.user.user_name}
      nativeOwnerId={services.localParticipationIdentity?.nativeOwnerUserId}
    />
  )
}

function CreateIssueForm({
  sources,
  projects,
  onClose,
  onCreated,
  viewerId,
  viewerName,
  nativeOwnerId,
}: CreateExperienceIssueProps & { viewerId: number; viewerName: string; nativeOwnerId?: number }) {
  const { t } = useTranslation('collaborationExp')
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [dueDate, setDueDate] = useState(tomorrowDate)
  const [riskLevel, setRiskLevel] = useState<'high' | 'low'>('high')
  const [selectedAssistants, setSelectedAssistants] = useState<string[]>([])
  const [selection, setSelection] = useState('standalone')
  const [assignee, setAssignee] = useState('self')
  const [submission] = useState(createExperienceIssueSubmission)
  const { pending, error } = useSyncExternalStore(submission.subscribe, submission.getSnapshot)
  const options = useMemo(
    () =>
      [...new Map(projects.map(row => [projectKey(row.project), row.project])).values()].filter(
        project => !isDefaultWorkItemProject(project)
      ),
    [projects]
  )
  const selectedProject = options.find(project => projectKey(project) === selection)
  const standalone = selection === 'standalone'
  const targetStore = standalone ? 'local' : selectedProject?.project_store
  const targetId = standalone ? DEFAULT_WORK_ITEM_PROJECT_ID : selectedProject?.id
  const source = sources.find(candidate => candidate.store === targetStore)
  const assistantRosterScopeKey = JSON.stringify([source?.store, targetId])
  const rosterResource = useMemo(
    () =>
      createAsyncResource<ProjectAssistantRosterEntry[]>(assistantRosterScopeKey, () =>
        source!.api.projects.listAssistantRoster!(targetId!)
      ),
    [assistantRosterScopeKey, source, targetId]
  )
  const rosterQuery = useSyncExternalStore(
    source?.store === 'backend' && targetId && source.api.projects.listAssistantRoster
      ? rosterResource.subscribe
      : subscribeIdleResource,
    rosterResource.getSnapshot
  )
  const assistantRoster = rosterQuery.data ?? []
  const assistantRosterKey = rosterQuery.data ? assistantRosterScopeKey : ''
  const assignableAssistantRoster = assistantRoster.filter(entry => entry.enabled)
  const currentAssistantRosterError =
    rosterQuery.status === 'error' ? errorText(rosterQuery.error) : null
  const resource = useMemo(
    () =>
      createAsyncResource(JSON.stringify([targetStore, targetId]), async signal => {
        const [project, members] = await Promise.all([
          source!.api.projects.get(targetId!),
          source!.api.members.list(targetId!),
        ])
        signal.throwIfAborted()
        if (project.id !== targetId || project.project_store !== source!.store)
          throw new Error(t('create.sourceUnavailable'))
        return { project, members }
      }),
    [source, targetId, targetStore, t]
  )
  const query = useSyncExternalStore(
    source && targetId ? resource.subscribe : subscribeIdleResource,
    resource.getSnapshot
  )
  const current = query.data
  const failure = query.status === 'error' ? errorText(query.error) : null
  const ready = Boolean(current)
  const canCreate = current && !failure && canAssignCollaborationIssue(current.project)
  const selfId =
    targetStore === 'local' ? nativeOwnerId : (current?.project.current_user_id ?? viewerId)
  const localIdentityUnavailable = targetStore === 'local' && nativeOwnerId === undefined
  const ref = useDialogKeyboard<HTMLElement>(() => {
    if (!submission.getSnapshot().pending) onClose()
  })

  const members =
    current?.members.filter(
      member =>
        selectableExperienceIssueMember(member) && ![viewerId, selfId].includes(member.user_id)
    ) ?? []
  const assigneeOptions = [
    { value: 'self', label: viewerName || t('create.me') },
    ...members.map(member => ({ value: String(member.user_id), label: member.user_name })),
  ]
  const assigneeLabel =
    assigneeOptions.find(option => option.value === assignee)?.label ??
    t('create.assigneeUnavailable')
  const changeTarget = (update: () => void) => {
    update()
    setAssignee('self')
    submission.clearError()
    submission.clearIntent()
    setRiskLevel('high')
    setSelectedAssistants([])
  }

  const submit = () => {
    if (pending || !title.trim() || !source || !targetId || !canCreate || selfId === undefined)
      return
    return submission.submit({
      source,
      targetId,
      title,
      summary,
      dueDate,
      riskLevel,
      selectedRoster: assistantRoster.filter(
        entry => entry.enabled && selectedAssistants.includes(entry.id)
      ),
      assignee,
      standalone,
      viewerId,
      nativeOwnerId,
      sourceCurrent: resource.hasSubscribers,
      messages: {
        sourceUnavailable: t('create.sourceUnavailable'),
        permissionDenied: t('create.permissionDenied'),
        assigneeUnavailable: t('create.assigneeUnavailable'),
      },
      onCreated,
    })
  }

  const select = (
    name: string,
    value: string,
    label: string,
    items: { value: string; label: string }[],
    onChange: (value: string) => void,
    disabled = false
  ) => (
    <IssueDetailSearchableSelect
      value={value}
      options={items}
      accessibleLabel={t(`create.${name}`)}
      searchPlaceholder={t('create.search')}
      emptyLabel={t('tasks.noMatches')}
      testId={`collaboration-exp-create-${name}`}
      className="experience-create-select"
      disabled={pending || disabled}
      onChange={onChange}
      triggerContent={
        <>
          <span>{label}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </>
      }
    />
  )

  return (
    <div className="experience-create-scrim">
      <section
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="collaboration-exp-create-title"
        aria-describedby="collaboration-exp-create-description"
        tabIndex={-1}
        data-testid="collaboration-exp-create-dialog"
        className="experience-create-dialog"
      >
        <DialogForm
          onSubmit={event => {
            event.preventDefault()
            void submit()
          }}
        >
          <header className="experience-create-header">
            <div>
              <span className="experience-create-kicker">{t('create.kicker')}</span>
              <h2 id="collaboration-exp-create-title">{t('create.title')}</h2>
              <p id="collaboration-exp-create-description">{t('create.description')}</p>
            </div>
            <button
              type="button"
              data-testid="collaboration-exp-create-close"
              aria-label={t('create.close')}
              className="experience-create-icon"
              disabled={pending}
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </button>
          </header>
          <div className="experience-create-body">
            <div className="experience-create-grid">
              <label className="experience-create-field experience-create-wide">
                <span>{t('create.goal')}</span>
                <input
                  data-testid="collaboration-exp-create-goal"
                  value={title}
                  disabled={pending}
                  placeholder={t('create.goalPlaceholder')}
                  onChange={event => setTitle(event.target.value)}
                />
              </label>
              <label className="experience-create-field">
                <span>{t('create.project')}</span>
                {select(
                  'project',
                  selection,
                  selectedProject
                    ? `${selectedProject.name} · ${t(`create.${selectedProject.project_store}`)}`
                    : t('create.standalone'),
                  [
                    { value: 'standalone', label: t('create.standalone') },
                    ...options.map(project => ({
                      value: projectKey(project),
                      label: `${project.name} · ${t(`create.${project.project_store}`)}`,
                    })),
                  ],
                  value => changeTarget(() => setSelection(value))
                )}
              </label>
              <label className="experience-create-field">
                <span>{t('create.assignee')}</span>
                {select('assignee', assignee, assigneeLabel, assigneeOptions, setAssignee, !ready)}
              </label>
              <label className="experience-create-field">
                <span>{t('create.dueDate')}</span>
                <input
                  type="date"
                  data-testid="collaboration-exp-create-dueDate"
                  value={dueDate}
                  disabled={pending}
                  onChange={event => setDueDate(event.target.value)}
                />
              </label>
              <label className="experience-create-field experience-create-wide">
                <span>{t('create.summary')}</span>
                <textarea
                  rows={3}
                  data-testid="collaboration-exp-create-summary"
                  value={summary}
                  disabled={pending}
                  placeholder={t('create.summaryPlaceholder')}
                  onChange={event => setSummary(event.target.value)}
                />
              </label>
              {assistantRosterKey === assistantRosterScopeKey &&
              assignableAssistantRoster.length > 0 ? (
                <label className="experience-create-field">
                  <span>{t('create.riskLevel')}</span>
                  {select(
                    'riskLevel',
                    riskLevel,
                    t(`create.risk.${riskLevel}`),
                    [
                      { value: 'high', label: t('create.risk.high') },
                      { value: 'low', label: t('create.risk.low') },
                    ],
                    value => {
                      setRiskLevel(value === 'low' ? 'low' : 'high')
                      submission.clearIntent()
                    }
                  )}
                </label>
              ) : null}
            </div>
            {assistantRosterKey === assistantRosterScopeKey &&
            assignableAssistantRoster.length > 0 ? (
              <fieldset
                className="experience-create-callout"
                data-testid="collaboration-exp-create-assistant-roster"
              >
                <legend>{t('create.assistantRoster')}</legend>
                {assignableAssistantRoster.map(entry => {
                  const selected = selectedAssistants.includes(entry.id)
                  return (
                    <label key={entry.id}>
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={pending}
                        data-testid={`collaboration-exp-create-assistant-${entry.id}`}
                        onChange={() => {
                          submission.clearIntent()
                          setSelectedAssistants(current => {
                            if (selected) return current.filter(id => id !== entry.id)
                            return [
                              ...current.filter(id => {
                                const candidate = assistantRoster.find(item => item.id === id)
                                return candidate?.userId !== entry.userId
                              }),
                              entry.id,
                            ]
                          })
                        }}
                      />
                      <span>
                        {entry.userName} · {entry.displayName}
                      </span>
                      <small>{t(`assistant.availability.${entry.availability}`)}</small>
                    </label>
                  )
                })}
              </fieldset>
            ) : null}
            <div className="experience-create-callout">
              <ShieldCheck aria-hidden="true" />
              <span>{t('create.defaults')}</span>
            </div>
            {!source || !targetId || localIdentityUnavailable ? (
              <p role="alert">{t('create.sourceUnavailable')}</p>
            ) : failure ? (
              <p role="alert">
                {failure}{' '}
                <button
                  type="button"
                  data-testid="collaboration-exp-create-retry"
                  onClick={() => {
                    void resource.reload()
                    if (source?.store === 'backend' && source.api.projects.listAssistantRoster)
                      void rosterResource.reload()
                  }}
                >
                  {t('retry')}
                </button>
              </p>
            ) : !ready ? (
              <p role="status">{t('create.loading')}</p>
            ) : !canCreate ? (
              <p role="alert">{t('create.permissionDenied')}</p>
            ) : null}
            {error ? <p role="alert">{error}</p> : null}
            {currentAssistantRosterError ? (
              <p role="alert">
                {currentAssistantRosterError}{' '}
                <button
                  type="button"
                  data-testid="collaboration-exp-create-assistant-roster-retry"
                  onClick={() => void rosterResource.reload()}
                >
                  {t('retry')}
                </button>
              </p>
            ) : null}
          </div>
          <footer className="experience-create-footer">
            <button
              type="button"
              className="experience-create-button"
              data-testid="collaboration-exp-create-cancel"
              disabled={pending}
              onClick={onClose}
            >
              {t('create.cancel')}
            </button>
            <button
              type="submit"
              className="experience-create-button experience-create-primary"
              data-testid="collaboration-exp-create-submit"
              disabled={pending || !title.trim() || !canCreate || localIdentityUnavailable}
            >
              {pending ? (
                <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              ) : (
                <Target aria-hidden="true" />
              )}
              {t('create.submit')}
            </button>
          </footer>
        </DialogForm>
      </section>
    </div>
  )
}
