import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Loader2, ShieldCheck, Target, X } from 'lucide-react'
import { canAssignCollaborationIssue, IssueDetailSearchableSelect } from '@wegent/collaboration'
import type {
  CollaborationIssue,
  CollaborationMember,
  CollaborationProject,
} from '@wegent/collaboration'
import { DEFAULT_WORK_ITEM_PROJECT_ID, isDefaultWorkItemProject } from '@/api/deliveries'
import { DialogForm } from '@/components/common/DialogForm'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { useTranslation } from '@/hooks/useTranslation'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { workbenchOwnershipKey } from '@/features/workbench/workbenchOwnership'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { projectScopeOf } from './model'
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

function selectableMember(member: CollaborationMember) {
  return member.can_be_assignee ?? member.role !== 'Viewer'
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
  const [selection, setSelection] = useState('standalone')
  const [assignee, setAssignee] = useState('self')
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const mounted = useRef(true)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
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
  const [loaded, setLoaded] = useState<{
    source: ExperienceSource
    id: string
    project: CollaborationProject
    members: CollaborationMember[]
  } | null>(null)
  const [loadError, setLoadError] = useState<{
    source?: ExperienceSource
    id?: string
    message: string
  } | null>(null)
  const current = loaded && loaded.source === source && loaded.id === targetId ? loaded : null
  const failure =
    loadError && loadError.source === source && loadError.id === targetId ? loadError.message : null
  const ready = Boolean(current)
  const canCreate = current && !failure && canAssignCollaborationIssue(current.project)
  const selfId =
    targetStore === 'local' ? nativeOwnerId : (current?.project.current_user_id ?? viewerId)
  const localIdentityUnavailable = targetStore === 'local' && nativeOwnerId === undefined
  const ref = useDialogKeyboard<HTMLElement>(() => {
    if (!pendingRef.current) onClose()
  })

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (!source || !targetId) return
    let cancelled = false
    void Promise.all([source.api.projects.get(targetId), source.api.members.list(targetId)]).then(
      ([project, members]) => {
        if (!cancelled) {
          if (project.id !== targetId || project.project_store !== source.store) {
            setLoadError({ source, id: targetId, message: t('create.sourceUnavailable') })
            return
          }
          setLoaded({ source, id: targetId, project, members })
          setLoadError(null)
        }
      },
      cause => {
        if (!cancelled) setLoadError({ source, id: targetId, message: errorText(cause) })
      }
    )
    return () => {
      cancelled = true
    }
  }, [source, targetId, retry, t])

  const members =
    current?.members.filter(
      member => selectableMember(member) && ![viewerId, selfId].includes(member.user_id)
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
    setError(null)
  }

  const submit = async () => {
    if (
      pendingRef.current ||
      !title.trim() ||
      !source ||
      !targetId ||
      !canCreate ||
      selfId === undefined
    )
      return
    pendingRef.current = true
    setPending(true)
    setError(null)
    try {
      const [project, freshMembers] = await Promise.all([
        source.api.projects.get(targetId),
        source.api.members.list(targetId),
      ])
      if (!mounted.current) return
      if (project.id !== targetId || project.project_store !== source.store)
        throw new Error(t('create.sourceUnavailable'))
      if (!canAssignCollaborationIssue(project)) throw new Error(t('create.permissionDenied'))
      const assigneeUserId =
        assignee === 'self'
          ? targetStore === 'local'
            ? nativeOwnerId
            : (project.current_user_id ?? viewerId)
          : freshMembers.find(
              member => String(member.user_id) === assignee && selectableMember(member)
            )?.user_id
      if (assigneeUserId === undefined) throw new Error(t('create.assigneeUnavailable'))
      const issue = await source.api.issues.create(project.id, {
        title: title.trim(),
        description: summary.trim(),
        assigneeUserId,
        ...(dueDate ? { dueAt: dueDate } : {}),
        ...(standalone && assignee === 'self' ? { personalTask: true } : {}),
      })
      if (mounted.current) onCreated(projectScopeOf(project), issue)
    } catch (cause) {
      if (mounted.current) setError(errorText(cause))
    } finally {
      pendingRef.current = false
      if (mounted.current) setPending(false)
    }
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
            </div>
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
                    setLoadError(null)
                    setRetry(value => value + 1)
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
