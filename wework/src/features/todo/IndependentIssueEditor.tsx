import { DefaultRunnerSetting } from '@/components/settings/DefaultRunnerSetting'
import { IssueProjectEnvironmentPicker } from './IssueProjectEnvironmentPicker'
import { useCallback, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createIndependentIssueDraft } from './independentIssueDraft'
import { ChevronDown, ChevronRight, Folder } from 'lucide-react'
import { IssueDetailSearchableSelect, type SharedWorkspaceApi } from '@wegent/collaboration'
import { usePanelData } from '@wegent/collaboration/platform'
import { DialogForm } from '@/components/common/DialogForm'
import { useTranslation } from '@/hooks/useTranslation'
import {
  type IndependentIssue,
  type IndependentIssueInput,
  type PersonalIssuesApi,
} from '@/api/personalIssues'
import type { TaskIssueShareDraft } from './TaskIssueShare'
import { TaskIssueShareFiles } from './TaskIssueShareFiles'
import { TaskIssueShareExcerpts } from './TaskIssueShareExcerpts'
import { IssueParticipantPicker } from './IssueParticipantPicker'
import { IssueProjectSelect } from './IssueProjectSelect'
import {
  participantKey,
  participantLabel,
  participantNeedsIdentifier,
  resourceInvitations,
  type IssueParticipant,
} from './issueParticipants'

export interface IssueCreationInput extends IndependentIssueInput {
  project_id?: string
  project_status?: string
}
const control =
  'wework-native-select min-h-11 min-w-0 w-full rounded-md border-0 bg-muted/40 px-2 py-1 text-sm text-text-primary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-ring md:min-h-8'

export function IndependentIssueEditor({
  api,
  collaborationApi,
  allowProjectSelection,
  issue,
  shareDraft,
  userId,
  busy,
  onSave,
  onCancel,
  onDirtyChange,
}: {
  api: PersonalIssuesApi
  collaborationApi?: SharedWorkspaceApi
  allowProjectSelection?: boolean
  issue: IndependentIssue | null
  shareDraft?: TaskIssueShareDraft
  userId: number
  busy: boolean
  onSave(input: IssueCreationInput, files: File[], conversationFileIds: string[]): Promise<void>
  onCancel(): void
  onDirtyChange?(dirty: boolean): void
}) {
  const { t } = useTranslation('common')
  const [selectedExcerpts, setSelectedExcerpts] = useState<string[]>([])
  const [shareFiles, setShareFiles] = useState<File[]>([])
  const [conversationFileIds, setConversationFileIds] = useState<string[]>([])
  const canSelectProject = allowProjectSelection ?? !issue
  const [draftOwner, setDraftOwner] = useState(() => ({
    api,
    userId,
    issueId: issue?.id,
    model: createIndependentIssueDraft(issue, userId, shareDraft?.title),
  }))
  if (
    draftOwner.api !== api ||
    draftOwner.userId !== userId ||
    (!shareDraft && draftOwner.issueId !== issue?.id)
  )
    setDraftOwner({
      api,
      userId,
      issueId: issue?.id,
      model: createIndependentIssueDraft(issue, userId, shareDraft?.title),
    })
  const model = draftOwner.model
  const subscribe = useCallback(
    (listener: () => void) =>
      model.subscribe(listener, dirty =>
        onDirtyChange?.(
          dirty ||
            selectedExcerpts.length > 0 ||
            shareFiles.length > 0 ||
            conversationFileIds.length > 0
        )
      ),
    [model, onDirtyChange, selectedExcerpts.length, shareFiles.length, conversationFileIds.length]
  )
  const { draft, people, projectId, projectStatus } = useSyncExternalStore(
    subscribe,
    model.getSnapshot,
    model.getSnapshot
  )
  const { setDraft, setPeople, setProjectId, setProjectStatus } = model
  const owner = issue?.creator_id ?? userId
  const loadProjects = useCallback(() => api.projects(), [api])
  const {
    data: projectPage,
    error: projectError,
    loading: loadingProjects,
    refresh: refreshProjects,
  } = usePanelData(loadProjects, canSelectProject)
  const projects = (projectPage?.items ?? []).filter(
    project =>
      ['local', 'backend'].includes(project.task_provider) &&
      project.access_role !== 'Viewer' &&
      (!shareDraft || project.project_store === 'backend')
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
  const audience = (
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
              className={`${control} flex-1`}
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
              {t(
                shareDraft
                  ? project?.default_issue_security === 'related'
                    ? 'taskIssueShare.relatedVisibility'
                    : 'taskIssueShare.projectVisibility'
                  : 'issue_creation.project_scope_hint'
              )}
            </p>
          )}
          {projectError !== undefined && (
            <p role="alert" className="text-sm text-destructive">
              {t('issue_creation.projects_load_failed')}
              <button
                type="button"
                data-testid="issue-project-retry"
                className="ml-2 inline-flex min-h-11 min-w-11 items-center justify-center rounded-md underline md:min-h-8"
                onClick={() => void refreshProjects()}
              >
                {t('independentIssues.retry')}
              </button>
            </p>
          )}
        </div>
      )}

      {shareDraft && !projectId && (
        <p className="text-sm text-text-secondary">{t('taskIssueShare.independentVisibility')}</p>
      )}
    </div>
  )
  return (
    <DialogForm
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      onSubmit={event => {
        event.preventDefault()
        if (busy || !draft.title.trim()) return
        const excerpts =
          shareDraft?.excerpts
            .filter(excerpt => selectedExcerpts.includes(excerpt.id))
            .map(excerpt => `${t(`taskIssueShare.${excerpt.role}`)} · ${excerpt.content}`) ?? []
        void onSave(
          {
            ...draft,
            ...(shareDraft && {
              description: [draft.description.trim(), ...excerpts].filter(Boolean).join('\n\n'),
            }),
            ...(projectId ? { project_id: projectId, project_status: projectStatus } : {}),
          },
          shareFiles,
          conversationFileIds
        )
      }}
    >
      <div
        data-testid="independent-issue-editor-scroll"
        className="min-h-0 flex-1 overflow-y-auto p-5 [container-type:inline-size]"
      >
        <fieldset
          disabled={busy}
          className="grid min-w-0 gap-5 [@container_(min-width:620px)]:grid-cols-[minmax(13rem,2fr)_minmax(0,3fr)]"
        >
          <aside className="grid min-w-0 content-start gap-2 [@container_(min-width:620px)]:border-r [@container_(min-width:620px)]:border-border [@container_(min-width:620px)]:pr-5">
            <p className="text-sm font-medium">{t('taskIssueShare.participantsOptional')}</p>
            <IssueParticipantPicker
              api={api}
              collaborationApi={collaborationApi}
              userId={userId}
              selected={people}
              colleaguesOnly={Boolean(shareDraft)}
              onChange={changePeople}
              disabled={busy || owner !== userId}
            />
            {shareDraft && draft.participants.length > 0 && (
              <p className="text-sm text-text-secondary">{t('taskIssueShare.notifyHint')}</p>
            )}
          </aside>
          <div className="grid min-w-0 content-start gap-3">
            <label className="grid gap-1">
              <span className="text-sm text-text-secondary">{t('independentIssues.title')}</span>
              <input
                required
                maxLength={255}
                data-testid="independent-issue-title"
                aria-label={t('independentIssues.title')}
                placeholder={t('issue_creation.title_placeholder')}
                value={draft.title}
                onChange={event => set('title', event.target.value)}
                className="min-h-11 w-full rounded-lg border border-border bg-background px-3 py-2 text-base font-medium outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-ring placeholder:text-text-secondary md:min-h-8"
              />
            </label>
            <label className="grid gap-1">
              <span className="text-sm text-text-secondary">
                {t('independentIssues.description')}
              </span>
              <textarea
                data-testid="independent-issue-description"
                aria-label={t('independentIssues.description')}
                placeholder={t('issue_creation.description_placeholder')}
                value={draft.description}
                onChange={event => set('description', event.target.value)}
                rows={3}
                className="w-full resize-y rounded-lg border border-border bg-background p-3 text-base leading-6 outline-none placeholder:text-text-secondary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-ring"
              />
            </label>
            {shareDraft && (
              <TaskIssueShareFiles
                sourceTitle={shareDraft.title}
                files={shareFiles}
                conversationFiles={shareDraft.conversationFiles}
                selectedConversationFileIds={conversationFileIds}
                onSelectConversationFiles={setConversationFileIds}
                onChange={setShareFiles}
              />
            )}
            {shareDraft && (
              <TaskIssueShareExcerpts
                excerpts={shareDraft.excerpts}
                selected={selectedExcerpts}
                onSelect={setSelectedExcerpts}
              />
            )}
            {audience}
            <details className="group min-w-0 border-t border-border pt-2">
              <summary
                data-testid="independent-issue-options"
                className="flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-md text-sm text-text-secondary hover:text-text-primary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-ring md:min-h-8 [&::-webkit-details-marker]:hidden"
              >
                <ChevronRight className="h-4 w-4 group-open:rotate-90" aria-hidden="true" />
                {t('taskIssueShare.issueOptions')}
              </summary>
              <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
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
                      onChange={event =>
                        set('status', event.target.value as IndependentIssue['status'])
                      }
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
                  <IssueDetailSearchableSelect
                    modal
                    testId="independent-issue-assignee"
                    accessibleLabel={t('independentIssues.assignee')}
                    className={`${control} flex items-center gap-2 text-left`}
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
                  <input
                    type="date"
                    data-testid="independent-issue-due"
                    className={control}
                    value={draft.due_at ?? ''}
                    onChange={event => set('due_at', event.target.value || null)}
                  />
                )}
              </div>
            </details>
            {!shareDraft && (
              <details className="group min-w-0 border-t border-border pt-2">
                <summary
                  data-testid="independent-issue-execution-settings"
                  className="flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-md text-sm text-text-secondary hover:text-text-primary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-ring md:min-h-8 [&::-webkit-details-marker]:hidden"
                >
                  <ChevronRight
                    className="h-4 w-4 transition-transform group-open:rotate-90 motion-reduce:transition-none"
                    aria-hidden="true"
                  />
                  {t('issue_creation.runtime_label')}
                </summary>
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
              </details>
            )}
          </div>
        </fieldset>
      </div>
      <div
        data-testid="independent-issue-editor-actions"
        className="flex shrink-0 flex-wrap items-center justify-end gap-3 border-t border-border bg-popover px-5 py-4"
      >
        <div className="flex shrink-0 gap-2">
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
                : shareDraft
                  ? draft.participants.length > 0
                    ? 'taskIssueShare.submit'
                    : 'issue_creation.create_issue'
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
