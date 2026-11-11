import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import {
  createCollaborationTranslator,
  collaborationMessages,
  threadStatuses,
  collectIssueSubtreeIds,
  createSharedIssueUpdatePort,
  dueDateTimeLocalFromSource,
  dueDateTimeLocalToSource,
  IssueDetailPrioritySelect,
  IssueDetailSearchableSelect,
  IssueDetailStatusSelect,
  isScheduleRangeInvalid,
  parseIssueAssigneeTarget,
  persistIssueDetailFields,
  useIssueDetailDraft,
  useIssueFieldSaves,
  type IssueDetailDraftValue,
  TagEditor,
  type CollaborationIssue,
  type CollaborationProject,
  type Milestone,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'
import type {
  ChatGroup,
  ChatGroupApi,
  ChatGroupMember,
  ThreadParticipation,
} from '@/api/chatGroups'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { useStandInPanelNavigation } from '@/features/todo/useStandInPanelNavigation'
import { ThreadParticipants } from './ThreadParticipants'
import type { ThreadHierarchyRenderContext } from './threadHierarchy'

const field =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-text-primary focus-visible:ring-2 focus-visible:ring-focus'
type ProjectLink = Awaited<ReturnType<ChatGroupApi['projectLink']>>

export function ThreadSettings({
  group,
  project,
  item,
  items,
  members,
  api,
  catalog,
  groups,
  participation,
  locale,
  onParticipation,
  onChanged,
  onClose,
  registerLeaveGuard,
  renderHierarchy,
}: {
  group: ChatGroup
  project: CollaborationProject
  item: CollaborationIssue
  items: CollaborationIssue[]
  members: ChatGroupMember[]
  api: SharedWorkspaceApi
  catalog: SharedWorkspaceApi
  groups: ChatGroupApi
  participation: ThreadParticipation | null
  locale: 'zh-CN' | 'en'
  onParticipation(value: ThreadParticipation): void
  onChanged(): void
  onClose(): void
  registerLeaveGuard?(guard: ((action: () => void) => void) | null): void
  renderHierarchy?(context: ThreadHierarchyRenderContext): ReactNode
}) {
  const { t } = useTranslation('collaboration')
  const translate = useMemo(() => createCollaborationTranslator(locale), [locale])
  const port = useMemo(() => createSharedIssueUpdatePort(api.issues), [api.issues])
  const [persisted, setPersisted] = useState<CollaborationIssue | null>(null)
  const current = persisted?.id === item.id && persisted.version > item.version ? persisted : item
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [projects, setProjects] = useState<CollaborationProject[]>([])
  const [link, setLink] = useState<ProjectLink | null>(null)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [selectedProject, setSelectedProject] = useState<string | null>(null)
  const [projectDraftVersion, setProjectDraftVersion] = useState<number | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  const [milestoneResult, setMilestoneResult] = useState<{
    projectId: string
    items: Milestone[]
    error: string | null
  } | null>(null)
  const [selectedMilestone, setSelectedMilestone] = useState<{ value: string } | null>(null)
  const editable = group.status === 'active' && group.role !== 'Viewer'
  const projectId = link?.project?.id ?? null
  const milestones = milestoneResult?.projectId === projectId ? milestoneResult.items : []
  const milestoneFailure = milestoneResult?.projectId === projectId ? milestoneResult.error : null
  const actualMilestone = selectedMilestone?.value ?? current.milestone_id ?? ''
  const fieldSaves = useIssueFieldSaves(current, updated => {
    setPersisted(updated)
    onChanged()
  })
  const { draft, setField, dirty } = useIssueDetailDraft({
    source: current,
    preserveEditedFields: fieldSaves.pending,
    initial: item,
    startDateFromSource: dueDateTimeLocalFromSource,
    dueDateFromSource: dueDateTimeLocalFromSource,
  })
  const descriptionDirty = draft.description !== current.description
  const canSaveDescription = descriptionDirty || fieldSaves.pendingKeys.includes('description')
  const busy = saving || fieldSaves.pending
  const invalidDates = isScheduleRangeInvalid(draft.startDate, draft.dueDate)
  const dateErrorId = useId()
  const excludedParents = useMemo(() => collectIssueSubtreeIds(items, item.id), [items, item.id])
  const metadataDirty = dirty || selectedMilestone !== null
  const navigation = useStandInPanelNavigation(
    metadataDirty || selectedProject !== null,
    busy,
    () => setConfirmClose(true)
  )
  useEffect(() => {
    registerLeaveGuard?.(navigation.requestLeave)
    return () => registerLeaveGuard?.(null)
  }, [registerLeaveGuard, navigation.requestLeave])
  const editableProjects = projects.filter(candidate =>
    ['Owner', 'Maintainer', 'Developer'].includes(candidate.access_role ?? '')
  )
  const canClassify =
    editable &&
    Boolean(link) &&
    !link?.restricted &&
    (!projectId || editableProjects.some(candidate => candidate.id === projectId))
  useEffect(() => {
    let active = true
    void groups
      .projectLink(item.id)
      .then(value => {
        if (active) setLink(value)
      })
      .catch(cause => {
        if (active) setProjectError(String(cause))
      })
    void catalog.projects
      .list()
      .then(value => {
        if (active) setProjects(value)
      })
      .catch(cause => {
        if (active) setProjectError(String(cause))
      })
    return () => {
      active = false
    }
  }, [groups, catalog, item.id, item.version])
  useEffect(() => {
    if (!projectId || !catalog.milestones) return
    let active = true
    void catalog.milestones
      .list(projectId)
      .then(value => {
        if (active) {
          setMilestoneResult({ projectId, items: value, error: null })
        }
      })
      .catch(cause => {
        if (active) setMilestoneResult({ projectId, items: [], error: String(cause) })
      })
    return () => {
      active = false
    }
  }, [catalog, projectId])
  const statuses = threadStatuses(collaborationMessages[locale])
  const saveProperties = (
    key: string,
    values: Parameters<typeof persistIssueDetailFields>[1],
    onSaved?: (updated: CollaborationIssue) => void
  ) => {
    if (!editable || saving) return
    setSaved(false)
    return fieldSaves.save(key, source => persistIssueDetailFields(source, values, port), onSaved)
  }
  const saveTitle = () => {
    const title = draft.title.trim()
    if (!title) return
    setField('title', title)
    void saveProperties('title', { title })
  }
  const changeProperty = <K extends keyof IssueDetailDraftValue>(
    key: K,
    value: IssueDetailDraftValue[K]
  ) => {
    setField(key, value)
    if (key === 'startDate' || key === 'dueDate') {
      const start = key === 'startDate' ? String(value) : draft.startDate
      const due = key === 'dueDate' ? String(value) : draft.dueDate
      if (isScheduleRangeInvalid(start, due)) return
      void saveProperties('schedule', {
        start_at:
          dueDateTimeLocalToSource(start, {
            sourceValue: current.start_at ?? null,
            sourceInputValue: dueDateTimeLocalFromSource(current.start_at ?? null),
          }) || null,
        due_at:
          dueDateTimeLocalToSource(due, {
            sourceValue: current.due_at,
            sourceInputValue: dueDateTimeLocalFromSource(current.due_at),
          }) || null,
      })
    } else if (key === 'assigneeTarget') {
      const assignment = parseIssueAssigneeTarget(value as IssueDetailDraftValue['assigneeTarget'])
      void saveProperties(key, {
        assignee_user_id: assignment.assigneeUserId,
        assignee_agent_id: assignment.assigneeAgentId,
        assignee_team_id: assignment.assigneeTeamId,
      })
    } else {
      void saveProperties(key, { [key === 'parentId' ? 'parent_id' : key]: value || null })
    }
  }
  const saveDescription = async () => {
    if (!canSaveDescription) return
    const updated = await saveProperties('description', { description: draft.description })
    if (updated) setSaved(true)
  }
  const applyProject = async () => {
    if (
      busy ||
      selectedProject === null ||
      !canClassify ||
      metadataDirty ||
      projectDraftVersion === null
    )
      return
    setSaving(true)
    setProjectError(null)
    try {
      const value = await groups.setProjectLink(
        item.id,
        projectDraftVersion,
        selectedProject || null
      )
      setLink(value)
      setSelectedProject(null)
      setProjectDraftVersion(null)
      setSelectedMilestone(null)
      setMilestoneResult(null)
      onChanged()
    } catch (cause) {
      setProjectError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }
  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background"
      data-testid="thread-settings-panel"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            data-testid="thread-settings-close"
            aria-label={t('close')}
            disabled={busy}
            onClick={() => navigation.requestLeave(onClose)}
            className="rounded p-1 text-text-muted hover:bg-hover"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <p className="truncate text-xs text-text-muted">
              {group.name} › {t('threadNumber', { number: item.sequence_number })}
            </p>
            <h1 className="text-heading-md text-text-primary">{t('threadSettings')}</h1>
          </div>
        </div>
        <Button
          type="submit"
          form="thread-metadata-form"
          data-testid="thread-settings-save"
          disabled={saving || !editable || !canSaveDescription}
        >
          {t('saveDescription')}
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-3xl space-y-8">
          <form
            id="thread-metadata-form"
            className="space-y-5"
            onSubmit={event => {
              event.preventDefault()
              void saveDescription()
            }}
          >
            <label className="block space-y-2 text-sm text-text-primary">
              <span>{t('threadTitle')}</span>
              <input
                data-testid="thread-settings-title"
                className={field}
                required
                maxLength={255}
                disabled={!editable || saving}
                value={draft.title}
                onChange={event => {
                  setField('title', event.target.value)
                  setSaved(false)
                }}
                onBlur={saveTitle}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    saveTitle()
                  }
                }}
              />
            </label>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="space-y-2 text-sm text-text-primary">
                <span>{t('status')}</span>
                <IssueDetailStatusSelect
                  className={field}
                  testId="thread-settings-status"
                  accessibleLabel={t('status')}
                  statuses={statuses}
                  value={draft.status}
                  disabled={!editable || saving}
                  onChange={value => changeProperty('status', value)}
                />
              </label>
              <label className="space-y-2 text-sm text-text-primary">
                <span>{t('priority')}</span>
                <IssueDetailPrioritySelect
                  className={field}
                  testId="thread-settings-priority"
                  accessibleLabel={t('priority')}
                  value={draft.priority}
                  disabled={!editable || saving}
                  labels={{
                    none: translate('todo.priority_none'),
                    low: translate('todo.priority_low'),
                    medium: translate('todo.priority_medium'),
                    high: translate('todo.priority_high'),
                    urgent: translate('todo.priority_urgent'),
                  }}
                  onChange={value => changeProperty('priority', value)}
                />
              </label>
              <label className="space-y-2 text-sm text-text-primary">
                <span>{t('assignee')}</span>
                <select
                  data-testid="thread-settings-assignee"
                  className={field}
                  disabled={!editable || saving}
                  value={draft.assigneeTarget}
                  onChange={event =>
                    changeProperty(
                      'assigneeTarget',
                      event.target.value as typeof draft.assigneeTarget
                    )
                  }
                >
                  <option value="">{t('unassigned')}</option>
                  {members
                    .filter(member => member.role !== 'Viewer')
                    .map(member => (
                      <option key={member.user_id} value={`user:${member.user_id}`}>
                        {member.user_id === 0 ? t('you') : member.name}
                      </option>
                    ))}
                  {draft.assigneeTarget && !draft.assigneeTarget.startsWith('user:') && (
                    <option value={draft.assigneeTarget}>
                      {item.assignee_agent_name ??
                        item.assignee_group_name ??
                        item.assignee_team_name ??
                        t('assignedAgent')}
                    </option>
                  )}
                </select>
              </label>
              <label className="space-y-2 text-sm text-text-primary">
                <span>{t('parentThread')}</span>
                <select
                  data-testid="thread-settings-parent"
                  className={field}
                  disabled={!editable || saving}
                  value={draft.parentId}
                  onChange={event => changeProperty('parentId', event.target.value)}
                >
                  <option value="">{t('none')}</option>
                  {items
                    .filter(candidate => !excludedParents.has(candidate.id))
                    .map(candidate => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.title}
                      </option>
                    ))}
                </select>
              </label>
              <label className="space-y-2 text-sm text-text-primary">
                <span>{t('startDate')}</span>
                <input
                  type="datetime-local"
                  data-testid="thread-settings-start"
                  aria-invalid={invalidDates || undefined}
                  aria-describedby={invalidDates ? dateErrorId : undefined}
                  className={field}
                  disabled={!editable || saving}
                  value={draft.startDate}
                  onChange={event => changeProperty('startDate', event.target.value)}
                />
              </label>
              <label className="space-y-2 text-sm text-text-primary">
                <span>{t('dueDate')}</span>
                <input
                  type="datetime-local"
                  data-testid="thread-settings-due"
                  aria-invalid={invalidDates || undefined}
                  aria-describedby={invalidDates ? dateErrorId : undefined}
                  className={field}
                  disabled={!editable || saving}
                  value={draft.dueDate}
                  onChange={event => changeProperty('dueDate', event.target.value)}
                />
              </label>
            </div>
            {invalidDates && (
              <p id={dateErrorId} role="alert" className="text-sm text-destructive">
                {t('invalidDates')}
              </p>
            )}
            <label className="block space-y-2 text-sm text-text-primary">
              <span>{t('tags')}</span>
              <span className="flex min-h-10 rounded-md border border-border px-3 py-2 focus-within:ring-2 focus-within:ring-focus">
                <TagEditor
                  tags={draft.tags}
                  onChange={value => changeProperty('tags', value)}
                  disabled={!editable || saving}
                  testIdPrefix="thread-settings-tags"
                  placeholder={t('addTag')}
                  lengthErrorLabel={t('tagTooLong')}
                  suggestions={project.tags}
                />
              </span>
              <small className="block text-xs text-text-muted">{t('tagsHelp')}</small>
            </label>
            <label className="block space-y-2 text-sm text-text-primary">
              <span>{t('threadDescription')}</span>
              <textarea
                data-testid="thread-settings-description"
                className={field}
                rows={5}
                disabled={!editable || saving}
                value={draft.description}
                onChange={event => {
                  setField('description', event.target.value)
                  setSaved(false)
                }}
              />
            </label>
            {projectId && (
              <label className="block space-y-2 text-sm text-text-primary">
                <span>{t('milestone')}</span>
                <IssueDetailSearchableSelect
                  testId="thread-settings-milestone"
                  accessibleLabel={t('milestone')}
                  className={field}
                  disabled={!editable || saving || Boolean(milestoneFailure)}
                  value={actualMilestone}
                  searchPlaceholder={translate('todo.search_milestone')}
                  emptyLabel={translate('todo.no_matching_milestone')}
                  options={[
                    { value: '', label: translate('todo.not_set') },
                    ...milestones.map(milestone => ({
                      value: milestone.id,
                      label: milestone.title,
                    })),
                  ]}
                  onChange={value => {
                    const selection = { value }
                    setSelectedMilestone(selection)
                    void saveProperties('milestone', { milestone_id: value || null }, () => {
                      setSelectedMilestone(current => (current === selection ? null : current))
                    })
                  }}
                />
              </label>
            )}
            {projectId && milestoneFailure && (
              <p role="alert" className="text-sm text-destructive">
                {milestoneFailure}
              </p>
            )}
            <p role="status" className="text-xs text-text-muted">
              {fieldSaves.pending ? t('savingProperties') : t('autosaveProperties')}
            </p>
            {Boolean(fieldSaves.error) && (
              <div role="alert" className="space-y-2 text-sm text-destructive">
                <p>
                  {fieldSaves.error instanceof Error ? fieldSaves.error.message : t('saveFailed')}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  data-testid="thread-settings-retry"
                  disabled={busy || !editable}
                  onClick={fieldSaves.retry}
                >
                  {t('retry')}
                </Button>
              </div>
            )}
            {saved && !descriptionDirty && (
              <p role="status" className="text-sm text-text-muted">
                {t('saved')}
              </p>
            )}
          </form>
          {renderHierarchy?.({
            item: current,
            classificationProject: canClassify
              ? editableProjects.find(
                  candidate => candidate.id === projectId && candidate.status === 'active'
                )
              : undefined,
            requestLeave: navigation.requestLeave,
          })}
          <section className="space-y-3 border-t border-border pt-6">
            <h2 className="text-sm font-medium text-text-primary">{t('optionalProject')}</h2>
            <p className="text-xs text-text-muted">{t('projectBoundary')}</p>
            {link ? (
              <div className="flex flex-wrap gap-2">
                <select
                  data-testid="thread-project-select"
                  aria-label={t('optionalProject')}
                  className={`${field} min-w-0 flex-1`}
                  value={
                    selectedProject ?? (link.restricted ? '__restricted__' : (projectId ?? ''))
                  }
                  disabled={!canClassify || busy || metadataDirty}
                  onChange={event => {
                    setSelectedProject(event.target.value)
                    if (projectDraftVersion === null) setProjectDraftVersion(link.thread_version)
                  }}
                >
                  {link.restricted && (
                    <option value="__restricted__" disabled>
                      {t('restrictedProject')}
                    </option>
                  )}
                  <option value="">{t('noProject')}</option>
                  {editableProjects.map(project => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  data-testid="thread-project-apply"
                  disabled={
                    !canClassify ||
                    metadataDirty ||
                    busy ||
                    selectedProject === null ||
                    selectedProject === (link.restricted ? '__restricted__' : (projectId ?? ''))
                  }
                  onClick={() => void applyProject()}
                >
                  {t('applyProject')}
                </Button>
              </div>
            ) : (
              <p role="status" className="text-sm text-text-muted">
                {t('loading')}
              </p>
            )}
            {metadataDirty && <p className="text-xs text-text-muted">{t('saveBeforeClassify')}</p>}
            {link && !canClassify && (
              <p className="text-xs text-text-muted">{t('classificationPermission')}</p>
            )}
            {!projectId && (
              <p className="text-xs text-text-muted">
                {t(link?.restricted ? 'restrictedMilestones' : 'milestoneRequiresProject')}
              </p>
            )}
            {projectError && (
              <p role="alert" className="text-sm text-destructive">
                {projectError}
              </p>
            )}
            {projectError && link && (
              <Button
                type="button"
                variant="ghost"
                data-testid="thread-project-reload"
                disabled={saving}
                onClick={() => {
                  setSaving(true)
                  void groups
                    .projectLink(item.id)
                    .then(value => {
                      setLink(value)
                      setSelectedProject(null)
                      setProjectDraftVersion(null)
                      setProjectError(null)
                      onChanged()
                    })
                    .catch(cause => setProjectError(String(cause)))
                    .finally(() => setSaving(false))
                }}
              >
                {t('reloadProject')}
              </Button>
            )}
          </section>
          <div className="border-t border-border pt-6">
            <ThreadParticipants
              group={group}
              threadId={item.id}
              members={members}
              participation={participation}
              api={groups}
              onChanged={onParticipation}
              onNavigationChanged={onChanged}
            />
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={confirmClose}
        title={t('discardTitle')}
        description={t('discardDescription')}
        cancelLabel={t('keepEditing')}
        confirmLabel={t('discard')}
        confirmTestId="thread-settings-discard"
        destructive
        pending={busy}
        onClose={() => {
          navigation.cancelLeave()
          setConfirmClose(false)
        }}
        onConfirm={() => navigation.confirmLeave(onClose)}
      />
    </section>
  )
}
