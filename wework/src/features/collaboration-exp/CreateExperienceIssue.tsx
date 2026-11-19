import { Checkbox } from '@wegent/collaboration/controls/Checkbox'
import { DEFAULT_WORK_ITEM_PROJECT_ID, isDefaultWorkItemProject } from '@/api/deliveries'
import { DialogForm } from '@/components/common/DialogForm'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { workbenchOwnershipKey } from '@/features/workbench/workbenchOwnership'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  CollaborationIssue,
  CollaborationMember,
  CollaborationProject,
  ProjectAssistantRosterEntry,
} from '@wegent/collaboration'
import { canAssignCollaborationIssue, SearchableSelect } from '@wegent/collaboration'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { Textarea as ControlTextarea } from '@wegent/collaboration/controls/Textarea'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { ChevronDown, Loader2, ShieldCheck, Target, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import './CreateExperienceIssue.css'
import type { ExperienceSource } from './data/useExperienceSources'
import type { ExperienceProjectData, ExperienceProjectScope } from './model'
import { projectScopeOf } from './model'

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
  const [riskLevel, setRiskLevel] = useState<'high' | 'low'>('high')
  const [selection, setSelection] = useState('standalone')
  const [assignee, setAssignee] = useState('self')
  const [assistantRoster, setAssistantRoster] = useState<ProjectAssistantRosterEntry[]>([])
  const [assistantRosterKey, setAssistantRosterKey] = useState('')
  const [assistantRosterError, setAssistantRosterError] = useState<{
    key: string
    message: string
  } | null>(null)
  const [assistantRosterRetry, setAssistantRosterRetry] = useState(0)
  const [selectedAssistants, setSelectedAssistants] = useState<string[]>([])
  const [dispatchIntent, setDispatchIntent] = useState<{
    id: string
    fingerprint: string
  } | null>(null)
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
  const assistantRosterScopeKey = JSON.stringify([source?.store, targetId])
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
  const ref = useRef<HTMLElement>(null)

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

  useEffect(() => {
    const currentKey = JSON.stringify([source?.store, targetId])
    if (
      !source ||
      !targetId ||
      source.store !== 'backend' ||
      !source.api.projects.listAssistantRoster
    ) {
      return
    }
    let cancelled = false
    void source.api.projects.listAssistantRoster(targetId).then(
      entries => {
        if (cancelled) return
        setAssistantRosterError(current => (current?.key === currentKey ? null : current))
        setAssistantRoster(entries)
        setAssistantRosterKey(currentKey)
        setSelectedAssistants(current =>
          current.filter(id => entries.some(row => row.id === id && row.enabled))
        )
      },
      cause => {
        if (!cancelled) {
          setAssistantRosterError({ key: currentKey, message: errorText(cause) })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [source, targetId, retry, assistantRosterRetry])

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
  const assignableAssistantRoster = assistantRoster.filter(entry => entry.enabled)
  const currentAssistantRosterError =
    assistantRosterError?.key === assistantRosterScopeKey ? assistantRosterError.message : null
  const changeTarget = (update: () => void) => {
    update()
    setAssignee('self')
    setError(null)
    setRiskLevel('high')
    setSelectedAssistants([])
    setDispatchIntent(null)
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
      const selectedRoster = assistantRoster.filter(entry => selectedAssistants.includes(entry.id))
      let issue: CollaborationIssue
      if (
        selectedRoster.length > 0 &&
        source.store === 'backend' &&
        source.api.projects.createAssistantDispatch
      ) {
        const fingerprint = JSON.stringify([
          title.trim(),
          summary.trim(),
          dueDate,
          riskLevel,
          assignee,
          selectedAssistants,
        ])
        const intentId =
          dispatchIntent?.fingerprint === fingerprint ? dispatchIntent.id : crypto.randomUUID()
        setDispatchIntent({ id: intentId, fingerprint })
        const dispatch = await source.api.projects.createAssistantDispatch(project.id, {
          intentId,
          goal: title.trim(),
          riskLevel,
          description: summary.trim(),
          ...(dueDate ? { dueAt: dueDate } : {}),
          managerUserId: assigneeUserId,
          confirmationState: 'confirmed',
          assignments: selectedRoster.map(entry => ({
            rosterEntryId: entry.id,
            userId: entry.userId,
            brief: summary.trim() || title.trim(),
          })),
        })
        issue = await source.api.issues.get(dispatch.rootIssueId)
      } else {
        issue = await source.api.issues.create(project.id, {
          title: title.trim(),
          description: summary.trim(),
          assigneeUserId,
          ...(dueDate ? { dueAt: dueDate } : {}),
          ...(standalone && assignee === 'self' ? { personalTask: true } : {}),
        })
      }
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
    <SearchableSelect
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
      <DialogSurface
        onClose={() => {
          if (!pendingRef.current) onClose()
        }}
        render={
          <section
            ref={ref}
            aria-labelledby="collaboration-exp-create-title"
            aria-describedby="collaboration-exp-create-description"
            tabIndex={-1}
            data-testid="collaboration-exp-create-dialog"
            className="experience-create-dialog"
          />
        }
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
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="collaboration-exp-create-close"
              aria-label={t('create.close')}
              className="experience-create-icon"
              disabled={pending}
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </ControlButton>
          </header>
          <div className="experience-create-body">
            <div className="experience-create-grid">
              <label className="experience-create-field experience-create-wide">
                <span>{t('create.goal')}</span>
                <ControlInput
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
                <ControlInput
                  type="date"
                  data-testid="collaboration-exp-create-dueDate"
                  value={dueDate}
                  disabled={pending}
                  onChange={event => setDueDate(event.target.value)}
                />
              </label>
              <label className="experience-create-field experience-create-wide">
                <span>{t('create.summary')}</span>
                <ControlTextarea
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
                      setDispatchIntent(null)
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
                      <Checkbox
                        checked={selected}
                        disabled={pending}
                        data-testid={`collaboration-exp-create-assistant-${entry.id}`}
                        onCheckedChange={() => {
                          setDispatchIntent(null)
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
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="collaboration-exp-create-retry"
                  onClick={() => {
                    setLoadError(null)
                    setRetry(value => value + 1)
                  }}
                >
                  {t('retry')}
                </ControlButton>
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
                <ControlButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  data-testid="collaboration-exp-create-assistant-roster-retry"
                  onClick={() => setAssistantRosterRetry(value => value + 1)}
                >
                  {t('retry')}
                </ControlButton>
              </p>
            ) : null}
          </div>
          <footer className="experience-create-footer">
            <ControlButton
              variant="unstyled"
              type="button"
              className="experience-create-button"
              data-testid="collaboration-exp-create-cancel"
              disabled={pending}
              onClick={onClose}
            >
              {t('create.cancel')}
            </ControlButton>
            <ControlButton
              variant="unstyled"
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
            </ControlButton>
          </footer>
        </DialogForm>
      </DialogSurface>
    </div>
  )
}
