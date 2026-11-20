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
import { DefaultRunnerSetting } from '@/components/settings/DefaultRunnerSetting'
import { IssueProjectEnvironmentPicker } from './IssueProjectEnvironmentPicker'
import { useCallback, useId, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { createIndependentIssueDraft } from './independentIssueDraft'
import { Folder } from 'lucide-react'
import { type SharedWorkspaceApi } from '@wegent/collaboration'
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
import { participantKey, resourceInvitations, type IssueParticipant } from './issueParticipants'

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
  titleSlot,
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
  titleSlot?: HTMLElement | null
  onSave(input: IssueCreationInput, files: File[], conversationFileIds: string[]): Promise<void>
  onCancel(): void
  onDirtyChange?(dirty: boolean): void
}) {
  const { t } = useTranslation('common')
  const formId = useId()
  const [selectedExcerpts, setSelectedExcerpts] = useState<string[]>([])
  const [allExcerpts, setAllExcerpts] = useState<TaskIssueShareDraft['excerpts'] | null>(null)
  const availableExcerpts = allExcerpts ?? shareDraft?.excerpts ?? []
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
  const changeAssignee = (person: IssueParticipant | null) =>
    setDraft(previous => ({
      ...previous,
      assignee_id: person?.kind === 'human' ? person.id : null,
      assignee_resource:
        person && person.kind !== 'human' ? { kind: person.kind, id: person.id } : null,
    }))
  const field = (label: string, children: ReactNode) => (
    <label className="flex min-w-0 items-center gap-2 text-sm">
      <span className="w-16 shrink-0 text-text-secondary">{label}</span>
      {children}
    </label>
  )
  const audience = (
    <div className="mt-2 grid min-w-0 gap-1">
      {canSelectProject && (
        <div className="grid grid-cols-1 gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <Folder className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
            <IssueProjectSelect
              projects={projects}
              className="min-h-11 min-w-0 flex-1 rounded-md px-2 py-1 text-sm text-text-primary hover:bg-muted md:min-h-8"
              triggerPlaceholder={t('issue_creation.project_label')}
              scopeHint={
                <span
                  data-testid="issue-project-scope"
                  className="block text-xs text-text-secondary"
                >
                  {t(
                    projectId
                      ? shareDraft
                        ? project?.default_issue_security === 'related'
                          ? 'taskIssueShare.relatedVisibility'
                          : 'taskIssueShare.projectVisibility'
                        : 'issue_creation.project_scope_hint'
                      : draft.participants.length || draft.resource_participants?.length
                        ? 'taskIssueShare.independentVisibility'
                        : 'taskIssueShare.privateVisibility'
                  )}
                </span>
              }
              disabled={loadingProjects}
              value={projectId}
              onChange={value => {
                setProjectId(value)
                const target = projects.find(row => String(row.id) === value)
                setProjectStatus(target?.board_config?.statuses[0]?.id ?? '')
              }}
            />
          </div>
          {loadingProjects && (
            <p
              role="status"
              data-testid="issue-project-loading"
              className="text-sm text-text-secondary"
            >
              {t('issue_creation.projects_loading')}
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
    </div>
  )
  return (
    <DialogForm
      id={formId}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      onSubmit={event => {
        event.preventDefault()
        if (busy || !draft.title.trim()) return
        const excerpts = availableExcerpts
          .filter(excerpt => selectedExcerpts.includes(excerpt.id))
          .map(excerpt => `${t(`taskIssueShare.${excerpt.role}`)} · ${excerpt.content}`)
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
      {!issue &&
        titleSlot &&
        createPortal(
          <ControlInput
            appearance="plain"
            form={formId}
            required
            maxLength={255}
            disabled={busy}
            data-testid="independent-issue-title"
            aria-label={t('independentIssues.title')}
            placeholder={t('issue_creation.title_placeholder')}
            value={draft.title}
            onChange={event => set('title', event.target.value)}
            className="min-h-11 w-full rounded-md bg-transparent px-1 text-heading-sm font-medium outline-none hover:bg-muted/40 keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-ring md:min-h-8"
          />,
          titleSlot
        )}
      <div
        data-testid="independent-issue-editor-scroll"
        className="min-h-0 flex-1 overflow-y-auto p-5 [container-type:inline-size]"
      >
        <fieldset
          disabled={busy}
          className="grid min-w-0 gap-5 [@container_(min-width:620px)]:grid-cols-[minmax(12rem,1fr)_minmax(0,2fr)]"
        >
          <aside className="flex min-w-0 flex-col gap-2 [@container_(min-width:620px)]:border-r [@container_(min-width:620px)]:border-border [@container_(min-width:620px)]:pr-5">
            <p className="flex min-h-11 items-center text-sm font-medium md:min-h-8">
              {t('taskIssueShare.participantsOptional')}
            </p>
            <IssueParticipantPicker
              api={api}
              collaborationApi={collaborationApi}
              userId={userId}
              selected={people}
              colleaguesOnly={Boolean(shareDraft)}
              onChange={changePeople}
              assigneeKey={assignee}
              onAssign={changeAssignee}
              ownerId={owner}
              disabled={busy || owner !== userId}
            />
            {shareDraft && draft.participants.length > 0 && (
              <p className="text-sm text-text-secondary">{t('taskIssueShare.notifyHint')}</p>
            )}
            {canSelectProject && <div className="mt-auto">{audience}</div>}
          </aside>
          <div className="grid min-w-0 content-start gap-3">
            {issue && (
              <label className="grid gap-1">
                <span className="text-sm text-text-secondary">{t('independentIssues.title')}</span>
                <ControlInput
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
            )}
            {shareDraft && (
              <TaskIssueShareFiles
                files={shareFiles}
                conversationFiles={shareDraft.conversationFiles}
                selectedConversationFileIds={conversationFileIds}
                selectedExcerptCount={selectedExcerpts.length}
                onSelectConversationFiles={setConversationFileIds}
                onChange={setShareFiles}
              >
                {shareDraft.historyUnavailable && (
                  <p role="alert" className="text-sm text-text-secondary">
                    {t('taskIssueShare.historyUnavailable')}
                  </p>
                )}
                {availableExcerpts.length > 0 && (
                  <TaskIssueShareExcerpts
                    excerpts={availableExcerpts}
                    loadAll={
                      shareDraft.history
                        ? async () => {
                            const excerpts = await shareDraft.history!.all()
                            setAllExcerpts(excerpts)
                            return excerpts
                          }
                        : undefined
                    }
                    selected={selectedExcerpts}
                    onSelect={setSelectedExcerpts}
                  />
                )}
              </TaskIssueShareFiles>
            )}
            <label className="grid gap-1">
              <span className="text-sm text-text-secondary">{t('taskIssueShare.todo')}</span>
              <ControlTextarea
                data-testid="independent-issue-description"
                aria-label={t('taskIssueShare.todo')}
                placeholder={t('taskIssueShare.todoPlaceholder')}
                value={draft.description}
                onChange={event => set('description', event.target.value)}
                rows={2}
                className={`w-full resize-y rounded-lg px-3 py-2 text-base leading-6 outline-none placeholder:text-text-secondary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-ring ${shareDraft ? 'border-0 bg-muted/40' : 'border border-border bg-background'}`}
              />
            </label>
            <CollapsibleRoot className="group min-w-0">
              <CollapsibleTrigger
                data-testid="independent-issue-options"
                className="flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-md text-sm text-text-secondary hover:text-text-primary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-ring md:min-h-8 [&::-webkit-details-marker]:hidden"
              >
                {t('taskIssueShare.issueOptions')}
              </CollapsibleTrigger>
              <CollapsiblePanel>
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
                    t('independentIssues.due'),
                    <ControlInput
                      type="date"
                      data-testid="independent-issue-due"
                      className={control}
                      value={draft.due_at ?? ''}
                      onChange={event => set('due_at', event.target.value || null)}
                    />
                  )}
                </div>
              </CollapsiblePanel>
            </CollapsibleRoot>
            {!shareDraft && (
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
            )}
          </div>
        </fieldset>
      </div>
      <div
        data-testid="independent-issue-editor-actions"
        className="flex shrink-0 flex-wrap items-center justify-end gap-3 border-t border-border bg-popover px-5 py-4"
      >
        <div className="flex shrink-0 gap-2">
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
            variant="unstyled"
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
          </ControlButton>
        </div>
      </div>
    </DialogForm>
  )
}
