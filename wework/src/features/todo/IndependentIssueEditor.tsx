import type {
  IndependentIssue,
  IndependentIssueInput,
  PersonalIssuesApi,
} from '@/api/personalIssues'
import { DialogForm } from '@/components/common/DialogForm'
import { DefaultRunnerSetting } from '@/components/settings/DefaultRunnerSetting'
import { useTranslation } from '@/hooks/useTranslation'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import { SearchableSelect } from '@wegent/collaboration'
import {
  CollapsiblePanel,
  CollapsibleRoot,
  CollapsibleTrigger,
} from '@wegent/collaboration/controls/Collapsible'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { normalizeSelectValue } from '@wegent/collaboration/controls/selectValue'
import { Textarea as ControlTextarea } from '@wegent/collaboration/controls/Textarea'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { usePanelData } from '@wegent/collaboration/platform'
import { ChevronDown, Folder } from 'lucide-react'
import type { ReactNode } from 'react'
import { useCallback, useState, useSyncExternalStore } from 'react'
import { createIndependentIssueDraft } from './independentIssueDraft'
import { IssueParticipantPicker } from './IssueParticipantPicker'
import type { IssueParticipant } from './issueParticipants'
import {
  participantKey,
  participantLabel,
  participantNeedsIdentifier,
  resourceInvitations,
} from './issueParticipants'
import { IssueProjectEnvironmentPicker } from './IssueProjectEnvironmentPicker'
import { IssueProjectSelect } from './IssueProjectSelect'

export interface IssueCreationInput extends IndependentIssueInput {
  project_id?: string
  project_status?: string
}

export function IndependentIssueEditor({
  api,
  collaborationApi,
  allowProjectSelection,
  issue,
  userId,
  busy,
  onSave,
  onCancel,
  onDirtyChange,
  autoFocus = true,
}: {
  api: PersonalIssuesApi
  collaborationApi?: SharedWorkspaceApi
  allowProjectSelection?: boolean
  issue: IndependentIssue | null
  userId: number
  busy: boolean
  onSave(input: IssueCreationInput): Promise<void>
  onCancel(): void
  onDirtyChange?(dirty: boolean): void
  autoFocus?: boolean
}) {
  const { t } = useTranslation('common')
  const canSelectProject = allowProjectSelection ?? !issue
  const [draftOwner, setDraftOwner] = useState(() => ({
    api,
    userId,
    issueId: issue?.id,
    model: createIndependentIssueDraft(issue, userId),
  }))
  if (draftOwner.api !== api || draftOwner.userId !== userId || draftOwner.issueId !== issue?.id)
    setDraftOwner({
      api,
      userId,
      issueId: issue?.id,
      model: createIndependentIssueDraft(issue, userId),
    })
  const model = draftOwner.model
  const subscribe = useCallback(
    (listener: () => void) => model.subscribe(listener, onDirtyChange),
    [model, onDirtyChange]
  )
  const { draft, people, projectId, projectStatus } = useSyncExternalStore(
    subscribe,
    model.getSnapshot,
    model.getSnapshot
  )
  const { setDraft, setPeople, setProjectId, setProjectStatus } = model
  const owner = issue?.creator_id ?? userId
  const loadProjects = useCallback(() => draftOwner.api.projects(), [draftOwner])
  const {
    data: projectPage,
    error: projectError,
    loading: loadingProjects,
    refresh: refreshProjects,
  } = usePanelData(loadProjects, canSelectProject)
  const projects = (projectPage?.items ?? []).filter(
    project =>
      ['local', 'backend'].includes(project.task_provider) && project.access_role !== 'Viewer'
  )
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
  const assigneeOptions = [
    { value: '', label: t('independentIssues.unassigned'), description: undefined },
    ...(['human', 'agent', 'group'] as const).flatMap(kind =>
      people
        .filter(person => person.kind === kind)
        .map(person => {
          const identified = participantNeedsIdentifier(person, people, userId)
          return {
            value: person.key,
            label: identified
              ? person.name
              : participantLabel(person, people, { id: userId, name: t('personalHome.me') }),
            description: identified ? `#${person.id}` : undefined,
            group: t(`issue_creation.participant_${kind}`),
            searchText: String(person.id),
          }
        })
    ),
  ]
  const selectedAssignee = assigneeOptions.find(option => option.value === assignee)
  const selection = (label: string, identifier?: string) => (
    <>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {identifier && <span className="shrink-0 text-text-secondary">{identifier}</span>}
      <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
    </>
  )
  const field = (label: string, children: ReactNode) => (
    <label className="flex min-w-0 items-center gap-2 text-sm">
      <span className="w-16 shrink-0 text-text-secondary">{label}</span>
      {children}
    </label>
  )
  return (
    <DialogForm
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      onSubmit={event => {
        event.preventDefault()
        if (busy || !draft.title.trim()) return
        void onSave({
          ...draft,
          ...(projectId ? { project_id: projectId, project_status: projectStatus } : {}),
        })
      }}
    >
      <div
        data-testid="independent-issue-editor-scroll"
        className="min-h-0 flex-1 overflow-y-auto p-5"
      >
        <fieldset disabled={busy} className="grid min-w-0 gap-3">
          <label className="grid gap-1">
            <span className="text-sm text-text-secondary">{t('independentIssues.title')}</span>
            <ControlInput
              density="compact"
              autoFocus={autoFocus}
              required
              maxLength={255}
              data-testid="independent-issue-title"
              aria-label={t('independentIssues.title')}
              placeholder={t('issue_creation.title_placeholder')}
              value={draft.title}
              onChange={event => set('title', event.target.value)}
              className="w-full text-base font-medium"
            />
          </label>
          <label className="grid gap-1">
            <span className="text-sm text-text-secondary">
              {t('independentIssues.description')}
            </span>
            <ControlTextarea
              data-testid="independent-issue-description"
              aria-label={t('independentIssues.description')}
              placeholder={t('issue_creation.description_placeholder')}
              value={draft.description}
              onChange={event => set('description', event.target.value)}
              rows={3}
              className="resize-y text-base leading-6"
            />
          </label>
          <div className="grid min-w-0 gap-3 border-t border-border pt-3">
            {canSelectProject && (
              <div className="grid grid-cols-1 gap-1">
                <label className="flex items-center gap-2 text-sm">
                  <Folder className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
                  <span className="shrink-0 text-text-secondary">
                    {t('issue_creation.project_label')}
                  </span>
                  <IssueProjectSelect
                    projects={projects}
                    className="flex-1"
                    disabled={loadingProjects}
                    value={projectId}
                    onChange={value => {
                      setProjectId(value)
                      const target = projects.find(row => String(row.id) === value)
                      setProjectStatus(target?.board_config?.statuses[0]?.id ?? '')
                    }}
                  />
                </label>
                {loadingProjects && (
                  <p
                    role="status"
                    data-testid="issue-project-loading"
                    className="text-sm text-text-secondary"
                  >
                    {t('issue_creation.projects_loading')}
                  </p>
                )}
                {projectId && (
                  <p data-testid="issue-project-scope" className="text-sm text-text-secondary">
                    {t('issue_creation.project_scope_hint')}
                  </p>
                )}
                {projectError !== undefined && (
                  <p role="alert" className="text-sm text-destructive">
                    {t('issue_creation.projects_load_failed')}
                    <ControlButton
                      variant="unstyled"
                      type="button"
                      data-testid="issue-project-retry"
                      className="ml-2 inline-flex min-h-11 min-w-11 items-center justify-center rounded-md underline md:min-h-8"
                      onClick={() => void refreshProjects()}
                    >
                      {t('independentIssues.retry')}
                    </ControlButton>
                  </p>
                )}
              </div>
            )}
            <IssueParticipantPicker
              api={api}
              collaborationApi={collaborationApi}
              userId={userId}
              selected={people}
              onChange={changePeople}
              disabled={busy || owner !== userId}
            />
          </div>
          <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
            {field(
              t('independentIssues.status'),
              projectId && statuses.length ? (
                <SelectRoot
                  value={normalizeSelectValue(projectStatus)}
                  onValueChange={selectedValue => {
                    if (selectedValue !== null) return setProjectStatus(selectedValue)
                  }}
                >
                  <SelectTrigger
                    density="compact"
                    aria-label={t('independentIssues.status')}
                    data-testid="independent-issue-project-status"
                    className="w-full"
                  />
                  <SelectContent>
                    {statuses.map(status => (
                      <SelectItem key={status.id} value={String(status.id)}>
                        {status.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </SelectRoot>
              ) : (
                <SelectRoot
                  value={normalizeSelectValue(draft.status)}
                  onValueChange={selectedValue => {
                    if (selectedValue !== null)
                      return set('status', selectedValue as IndependentIssue['status'])
                  }}
                >
                  <SelectTrigger
                    density="compact"
                    aria-label={t('independentIssues.status')}
                    data-testid="independent-issue-status"
                    className="w-full"
                  />
                  <SelectContent>
                    {(['pending', 'in_progress', 'completed'] as const).map(status => (
                      <SelectItem key={status} value={String(status)}>
                        {t(`independentIssues.${status}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </SelectRoot>
              )
            )}
            {field(
              t('independentIssues.priority'),
              <SelectRoot
                value={normalizeSelectValue(draft.priority)}
                onValueChange={selectedValue => {
                  if (selectedValue !== null)
                    return set('priority', selectedValue as IndependentIssue['priority'])
                }}
              >
                <SelectTrigger
                  density="compact"
                  aria-label={t('independentIssues.priority')}
                  data-testid="independent-issue-priority"
                  className="w-full"
                />
                <SelectContent>
                  {(['low', 'medium', 'high', 'urgent'] as const).map(priority => (
                    <SelectItem key={priority} value={String(priority)}>
                      {t(`independentIssues.${priority}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </SelectRoot>
            )}
            {field(
              t('independentIssues.assignee'),
              <SearchableSelect
                modal
                testId="independent-issue-assignee"
                accessibleLabel={t('independentIssues.assignee')}
                density="compact"
                className="w-full"
                value={assignee}
                options={assigneeOptions}
                searchPlaceholder={t('todo.search_assignee')}
                emptyLabel={t('todo.no_matching_assignee')}
                triggerContent={selection(
                  selectedAssignee?.label ?? t('independentIssues.unassigned'),
                  selectedAssignee?.description
                )}
                onChange={value => {
                  const target = people.find(person => person.key === value)
                  setDraft(previous => ({
                    ...previous,
                    assignee_id: target?.kind === 'human' ? target.id : null,
                    assignee_resource:
                      target && target.kind !== 'human'
                        ? { kind: target.kind, id: target.id }
                        : null,
                  }))
                }}
              />
            )}
            {field(
              t('independentIssues.due'),
              <ControlInput
                density="compact"
                type="date"
                data-testid="independent-issue-due"
                className="w-full"
                value={draft.due_at ?? ''}
                onChange={event => set('due_at', event.target.value || null)}
              />
            )}
          </div>
          <CollapsibleRoot className="group min-w-0 border-t border-border pt-2">
            <CollapsibleTrigger
              data-testid="independent-issue-execution-settings"
              className="flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-md text-sm text-text-secondary hover:text-text-primary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-ring md:min-h-8 [&::-webkit-details-marker]:hidden"
            >
              {t('issue_creation.runtime_label')}
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <div className="grid min-w-0 gap-2 pt-2">
                <span className="text-sm text-text-secondary">
                  {t(
                    projectId
                      ? 'issue_creation.project_device_settings'
                      : 'workbench.runner_personal_default'
                  )}
                </span>
                {projectId && collaborationApi ? (
                  <IssueProjectEnvironmentPicker
                    key={projectId}
                    api={collaborationApi}
                    projectId={projectId}
                    disabled={busy}
                  />
                ) : (
                  <DefaultRunnerSetting compact confirmChanges />
                )}
                <p className="text-xs text-text-secondary">
                  {t(
                    projectId
                      ? 'issue_creation.project_device_settings_hint'
                      : 'issue_creation.personal_runner_hint'
                  )}
                </p>
              </div>
            </CollapsiblePanel>
          </CollapsibleRoot>
        </fieldset>
      </div>
      <div
        data-testid="independent-issue-editor-actions"
        className="flex shrink-0 items-center justify-end gap-3 border-t border-border bg-popover px-5 py-4"
      >
        <div className="flex gap-2">
          <ControlButton
            variant="unstyled"
            type="button"
            disabled={busy}
            data-testid="independent-issue-editor-cancel"
            onClick={onCancel}
            className="min-h-11 rounded-md px-3 text-sm hover:bg-muted md:min-h-8"
          >
            {t('independentIssues.cancel')}
          </ControlButton>
          <ControlButton
            variant="primary"
            size="sm"
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
          </ControlButton>
        </div>
      </div>
    </DialogForm>
  )
}
