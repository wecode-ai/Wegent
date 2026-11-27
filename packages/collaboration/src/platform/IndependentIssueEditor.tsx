import { selectedShareExcerpts } from './selectedShareExcerpts'
import { CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger } from '../controls/Collapsible'
import { Popover, PopoverContent, PopoverTrigger } from '../controls/Popover'
import { SelectContent, SelectItem, SelectRoot, SelectTrigger } from '../controls/SelectParts'
import { normalizeSelectValue } from '../controls/selectValue'
import { Textarea as ControlTextarea } from '../controls/Textarea'
import { TextField as ControlInput } from '../controls/TextField'
import { Button as ControlButton } from '../markdown/Button'
import {
  useCallback,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type ComponentType,
} from 'react'
import { createPortal } from 'react-dom'
import { createIndependentIssueDraft } from './independentIssueDraft'
import { ChevronUp, Folder } from 'lucide-react'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationProject } from '../types'
import { usePanelData } from './usePanelData'
import { DialogForm } from '../controls/DialogForm'
import { usePersonalIssueTranslation } from './personalIssueMessages'
import {
  type IndependentIssue,
  type IndependentIssueInput,
  type IssueCreationInput,
  type PersonalIssuesApi,
  type TaskIssueShareDraft,
} from './personalIssuesApi'
import { TaskIssueShareExcerpts } from './TaskIssueShareExcerpts'
import { IssueParticipantPicker } from './IssueParticipantPicker'
import { IssueProjectSelect } from './IssueProjectSelect'
import { participantKey, resourceInvitations, type IssueParticipant } from './issueParticipants'

export type IssueShareFiles = ComponentType<{
  files: File[]
  conversationFiles: TaskIssueShareDraft['conversationFiles']
  selectedConversationFileIds: string[]
  selectedExcerptCount: number
  children: ReactNode
  messageActions?: ReactNode
  showConversation?: boolean
  onSelectConversationFiles(ids: string[]): void
  onChange(files: File[]): void
}>
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
  ShareFiles,
  renderExecutionSettings,
}: {
  api: PersonalIssuesApi<CollaborationProject>
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
  ShareFiles?: IssueShareFiles
  renderExecutionSettings?(projectId: string, busy: boolean): ReactNode
}) {
  const t = usePersonalIssueTranslation()
  const formId = useId()
  const selection = shareDraft?.selectedExcerpt
  const [shareWholeMessage, setShareWholeMessage] = useState(false)
  const [selectedExcerpts, setSelectedExcerpts] = useState<string[]>(
    selection ? [selection.excerpt.id] : []
  )
  const [olderExcerpts, setOlderExcerpts] = useState<TaskIssueShareDraft['excerpts']>([])
  const [beforeCursor, setBeforeCursor] = useState<string | null>()
  const [localPageSize, setLocalPageSize] = useState(1)
  const preview = shareDraft?.excerpts ?? []
  const history = shareDraft?.history
  const firstExcerpt = history && preview.length < 2 ? undefined : preview[0]
  const loadedTail = history ? olderExcerpts : preview.slice(-localPageSize)
  const conversationExcerpts = [
    ...new Map(
      [firstExcerpt, ...loadedTail, preview.at(-1)].flatMap(excerpt =>
        excerpt ? [[excerpt.id, excerpt] as const] : []
      )
    ).values(),
  ]
  const availableExcerpts = selectedShareExcerpts(conversationExcerpts, selection)
  const hasEarlier = history ? beforeCursor !== null : preview.length > localPageSize + 1
  const loadEarlier = async () => {
    if (!history) {
      setLocalPageSize(size => size + 16)
      return
    }
    if (beforeCursor === null) return
    const page = await history.earlier(beforeCursor)
    setOlderExcerpts(excerpts => [...page.excerpts, ...excerpts])
    setBeforeCursor(page.beforeCursor)
  }
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
    (!shareDraft && !allowProjectSelection && draftOwner.issueId !== issue?.id)
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
  const optionsTrigger = useRef<HTMLButtonElement>(null)
  const creating = !issue
  const hasInvitees = Boolean(draft.participants.length || draft.resource_participants?.length)
  const creationVisibility = t(
    projectId
      ? shareDraft
        ? project?.default_issue_security === 'related'
          ? 'taskIssueShare.relatedAudience'
          : 'taskIssueShare.projectAudience'
        : 'issue_creation.project_scope_hint'
      : hasInvitees
        ? 'taskIssueShare.invitedAudience'
        : 'taskIssueShare.selfAudience'
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
                creating && !projectId ? undefined : (
                  <span
                    data-testid="issue-project-scope"
                    className="block truncate text-xs text-text-secondary"
                    title={creationVisibility}
                  >
                    {creationVisibility}
                  </span>
                )
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
  const issueOptions = (
    <div className={`grid grid-cols-1 gap-x-4 gap-y-2 ${creating ? '' : 'sm:grid-cols-2'}`}>
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
  )
  const executionSettings = (
    <>
      {renderExecutionSettings && (
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
              {renderExecutionSettings(projectId, busy)}
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
    </>
  )
  const renderShareContent =
    creating && ShareFiles
      ? (messages?: ReactNode, messageActions?: ReactNode) => (
          <ShareFiles
            messageActions={messageActions}
            showConversation={Boolean(shareDraft)}
            files={shareFiles}
            conversationFiles={shareDraft?.conversationFiles ?? []}
            selectedConversationFileIds={conversationFileIds}
            selectedExcerptCount={selectedExcerpts.length}
            onSelectConversationFiles={setConversationFileIds}
            onChange={setShareFiles}
          >
            {shareDraft?.historyUnavailable && (
              <p role="alert" className="text-sm text-text-secondary">
                {t('taskIssueShare.firstUnavailable')}
              </p>
            )}
            {messages}
          </ShareFiles>
        )
      : undefined
  const blankCreation = creating && !shareDraft
  const description = (
    <label className={blankCreation ? 'flex min-h-0 flex-1 flex-col gap-1.5' : 'grid gap-1.5'}>
      <span className="text-sm font-medium">{t('taskIssueShare.description')}</span>
      <ControlTextarea
        data-testid="independent-issue-description"
        placeholder={t('taskIssueShare.descriptionPlaceholder')}
        value={draft.description}
        onChange={event => set('description', event.target.value)}
        rows={2}
        className={`w-full resize-y rounded-lg border border-border bg-transparent px-3 py-2.5 text-sm leading-6 outline-none placeholder:text-text-secondary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-ring ${creating ? 'min-h-28 flex-1' : ''}`}
      />
    </label>
  )
  const issueOptionsLabel = t('taskIssueShare.issueOptions')
  return (
    <DialogForm
      id={formId}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      onSubmit={event => {
        event.preventDefault()
        if (busy || !draft.title.trim()) return
        const excerpts = availableExcerpts
          .filter(excerpt => selectedExcerpts.includes(excerpt.id))
          .map(excerpt => {
            const content =
              selection?.excerpt.id === excerpt.id && !shareWholeMessage
                ? excerpt.content.slice(selection.start, selection.end)
                : excerpt.content
            return `${t(`taskIssueShare.${excerpt.role}`)} · ${content}`
          })
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
        className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5 [container-type:inline-size]"
      >
        <fieldset disabled={busy} className="contents">
          <div className="grid min-w-0 shrink-0 gap-5 [@container_(min-width:620px)]:grow [@container_(min-width:620px)]:grid-cols-[minmax(12rem,1fr)_minmax(0,2fr)]">
            <aside className="flex min-w-0 flex-col gap-2 [@container_(min-width:620px)]:border-r [@container_(min-width:620px)]:border-border [@container_(min-width:620px)]:pr-5">
              <p className="flex min-h-11 items-center text-sm font-medium md:min-h-8">
                {t('taskIssueShare.participantsOptional')}
              </p>
              <IssueParticipantPicker
                api={api}
                collaborationApi={collaborationApi}
                userId={userId}
                selected={people}
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
            <div
              className={`min-w-0 gap-3 ${blankCreation ? 'flex flex-col' : 'grid content-start'}`}
            >
              {issue && (
                <label className="grid gap-1">
                  <span className="text-sm text-text-secondary">
                    {t('independentIssues.title')}
                  </span>
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
              {blankCreation && description}
              {renderShareContent &&
                (shareDraft ? (
                  <TaskIssueShareExcerpts
                    excerpts={conversationExcerpts}
                    selection={selection}
                    shareWholeMessage={shareWholeMessage}
                    onShareWholeMessage={setShareWholeMessage}
                    firstAvailable={Boolean(firstExcerpt)}
                    loadEarlier={hasEarlier ? loadEarlier : undefined}
                    selected={selectedExcerpts}
                    onSelect={setSelectedExcerpts}
                    renderShareContent={renderShareContent}
                  />
                ) : (
                  renderShareContent()
                ))}
              {!blankCreation && description}
              {issue && (
                <CollapsibleRoot className="group min-w-0">
                  <CollapsibleTrigger
                    data-testid="independent-issue-options"
                    className="text-text-secondary hover:text-text-primary"
                  >
                    {issueOptionsLabel}
                  </CollapsibleTrigger>
                  <CollapsiblePanel>{issueOptions}</CollapsiblePanel>
                </CollapsibleRoot>
              )}
              {!creating && executionSettings}
            </div>
          </div>
        </fieldset>
      </div>
      <div
        data-testid="independent-issue-editor-actions"
        className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border bg-popover px-5 py-4"
      >
        {creating && (
          <Popover>
            <PopoverTrigger
              render={
                <ControlButton
                  ref={optionsTrigger}
                  variant="unstyled"
                  type="button"
                  disabled={busy}
                />
              }
              data-testid="independent-issue-options"
              className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm text-text-secondary hover:bg-muted hover:text-text-primary md:min-h-8"
            >
              <ChevronUp className="size-4" aria-hidden="true" />
              {issueOptionsLabel}
            </PopoverTrigger>
            <PopoverContent
              aria-label={issueOptionsLabel}
              data-testid="independent-issue-options-panel"
              side="top"
              align="start"
              finalFocus={() => optionsTrigger.current}
              className="w-96 p-3"
            >
              <fieldset disabled={busy} className="grid min-w-0 gap-3">
                {issueOptions}
                {executionSettings}
              </fieldset>
            </PopoverContent>
          </Popover>
        )}
        {creating && (
          <p
            role="status"
            data-testid="task-issue-share-visibility"
            className="order-first w-full text-right text-xs text-text-secondary md:order-none md:ml-auto md:w-auto"
          >
            {creationVisibility}
          </p>
        )}
        <div className={`ml-auto flex shrink-0 gap-2 ${creating ? 'md:ml-0' : ''}`}>
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
