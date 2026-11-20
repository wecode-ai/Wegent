import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { LOCAL_USER } from '@/api/local/localSession'
import type { ChatInputHandle, ProjectWorkControls } from '@/components/chat/ChatInput'
import { BufferedChatInput } from '@/components/layout/BufferedChatInput'
import { toWorkspaceRuntimeTaskAddress } from '@/features/workbench/projectTaskTracking'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useWorkbenchAttachments } from '@/features/workbench/useWorkbenchAttachments'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { resolveProjectRuntimeWorkspaceTarget } from '@/lib/workspace-target'
import { truncateRuntimeTaskTitle } from '@wegent/chat-core/runtime-task-title'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import { persistIssueDetailFields } from '@wegent/collaboration'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import type { IssueHomeTaskComposerProps } from '@wegent/collaboration/platform'
import {
  useCallback,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { issueRuntimePort } from './issueRuntimePort'
import type { PersonalHomeTaskDraft, PersonalHomeTaskDrafts } from './personalHomeTaskDrafts'
import { PersonalHomeTaskDraftSession } from './personalHomeTaskDraftSession'
import { prepareIssueRuntimeTask } from './prepareIssueRuntimeTask'
import { buildWorkItemRuntimeContext } from './workItemRuntimeContext'

interface PersonalHomeTaskComposerProps {
  draft: IssueHomeTaskComposerProps
  api: SharedWorkspaceApi
  services: WorkbenchServices
  drafts: PersonalHomeTaskDrafts
}

export function PersonalHomeTaskComposer(props: PersonalHomeTaskComposerProps) {
  const project = props.draft.projects.find(item => item.id === props.draft.projectId)
  const key = project ? `${project.project_store}:${project.id}` : ''
  const [selection, setSelection] = useState(() => ({
    key,
    api: props.api,
    drafts: props.drafts,
    revision: 0,
    initial: props.drafts.get(key),
  }))
  if (selection.key !== key || selection.api !== props.api || selection.drafts !== props.drafts) {
    const sameOwner = selection.api === props.api && selection.drafts === props.drafts
    const previous = sameOwner ? props.drafts.get(selection.key) : undefined
    const initial =
      props.drafts.get(key) ??
      (previous
        ? {
            ...previous,
            issue: undefined,
            requestedTitle: '',
            pendingContentUpdate: false,
          }
        : undefined)
    setSelection({
      key,
      api: props.api,
      drafts: props.drafts,
      revision: selection.revision + 1,
      initial,
    })
  }
  return <ProjectTaskComposer key={selection.revision} {...props} initial={selection.initial} />
}

/** Use the Tasks composer and its real controls; only the Issue linkage belongs here. */
function ProjectTaskComposer({
  draft,
  api,
  services,
  drafts,
  initial,
}: PersonalHomeTaskComposerProps & { initial?: PersonalHomeTaskDraft }) {
  const { t } = useTranslation('common')
  const workbench = useWorkbench()
  const { state, projectChat } = workbench
  const scopeKey = useId()
  const input = useRef<ChatInputHandle>(null)
  const project = draft.projects.find(item => item.id === draft.projectId)
  const projectKey = project ? `${project.project_store}:${project.id}` : null
  const attachments = useWorkbenchAttachments({
    scopeKey,
    uploadAttachment: services.attachmentApi?.uploadAttachment,
    deleteAttachment: services.attachmentApi?.deleteAttachment,
    initialState: {
      scopeKey,
      attachments: initial?.attachments.map(attachment => ({
        attachment,
        file: initial.attachmentFiles?.get(attachment.id),
      })),
    },
  })
  const [session] = useState(
    () =>
      new PersonalHomeTaskDraftSession({
        source: attachments.source,
        drafts,
        projectKey,
        initial,
        value: draft.value,
      })
  )
  const subscribe = useCallback(
    (listener: () => void) => session.observe(draft, listener),
    [draft, session]
  )
  const taskDraft = useSyncExternalStore(subscribe, session.getSnapshot, session.getSnapshot)
  const { goalDraftActive, error } = taskDraft
  const setError = session.setError
  const cacheDraft = session.setValue
  const savedIssue = projectKey ? drafts.get(projectKey)?.issue : undefined
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const [, refreshDraft] = useState(0)
  const { removeSourceFile } = attachments
  useImperativeHandle(
    draft.ref,
    () => ({
      get element() {
        return input.current?.element ?? null
      },
      focus: () => input.current?.focus(),
      getValue: () => input.current?.getValue() ?? session.getValue(),
      setValue: (value, offset) => {
        session.setValue(value)
        input.current?.setValue(value, offset)
      },
      insertReference: reference => input.current?.insertReference(reference),
    }),
    [session]
  )
  const projectWork: ProjectWorkControls = {
    projectSelectorLabel: t('personalHome.codeWorkspace'),
    projectMenuLabels: {
      search: t('personalHome.codeWorkspaceSearch'),
      empty: t('personalHome.codeWorkspaceEmpty'),
      emptyHint: t('personalHome.codeWorkspaceHint'),
      noResults: t('personalHome.codeWorkspaceNoResults'),
      clear: t('personalHome.codeWorkspaceNone'),
      addLocal: t('personalHome.codeWorkspaceAdd'),
    },
    projects: state.projects,
    devices: state.devices,
    runtimeWork: state.runtimeWork,
    currentProject: state.currentProject,
    currentProjectId: state.currentProject?.id,
    currentStandaloneDeviceId: state.standaloneDeviceId,
    selectedDeviceWorkspaceId: state.selectedDeviceWorkspaceId,
    pendingProjectWorkspaceProjectId: state.pendingProjectWorkspaceProjectId,
    executionMode: workbench.projectExecutionMode,
    executionModeLocked: false,
    worktreeBranch: workbench.projectWorktreeBranch,
    onSelectProject: id => workbench.selectProject(id, { navigate: false }),
    onSelectStandaloneDevice: id => workbench.selectStandaloneDevice(id, { navigate: false }),
    onSelectProjectWorkspace: (id, workspaceId) =>
      workbench.selectProjectWorkspace(id, workspaceId, { navigate: false }),
    onBindProjectWorkspace: id => workbench.selectProject(id, { navigate: false }),
    onExecutionModeChange: workbench.setProjectExecutionMode,
    onWorktreeBranchChange: workbench.setProjectWorktreeBranch,
  }
  const workspaceTarget =
    resolveProjectRuntimeWorkspaceTarget({
      currentProject: state.currentProject,
      runtimeWork: state.runtimeWork,
      selectedDeviceWorkspaceId: state.selectedDeviceWorkspaceId,
    }) ??
    (state.standaloneDeviceId && state.standaloneWorkspacePath
      ? {
          deviceId: state.standaloneDeviceId,
          path: state.standaloneWorkspacePath,
          source: 'runtime' as const,
        }
      : null)
  const removeTaskAttachment = async (id: number) => {
    const source = attachments.getSourceFile(id)
    if (!source) return attachments.removeAttachment(id)
    draft.onRemovePendingFile(source)
    await removeSourceFile(source)
  }
  const submit = async (value = draft.value) => {
    const content = value.trim()
    const selectedAttachments = attachments.getSelectedAttachments(session.selectedFiles())
    const port = project && issueRuntimePort(project.project_store, services)
    if (
      (!content && selectedAttachments.length === 0) ||
      !project ||
      draft.active === false ||
      !port ||
      submittingRef.current ||
      !projectChat.isModelSelectionReady ||
      !attachments.isAttachmentReadyToSend ||
      attachments.errors.size
    )
      return false
    submittingRef.current = true
    setSubmitting(true)
    draft.onPendingChange?.(true)
    setError(null)
    try {
      const projectKey = `${project.project_store}:${project.id}`
      const previous = drafts.get(projectKey)
      let issue = previous?.issue ? await api.issues.get(previous.issue.id) : undefined
      const title =
        truncateRuntimeTaskTitle(
          content.replace(/\s+/g, ' ') || selectedAttachments.map(file => file.filename).join('、')
        ) ?? t('todo.new_task')
      if (!issue)
        issue = await api.issues.create(project.id, {
          title,
          description: content,
          assigneeUserId:
            project.project_store === 'local'
              ? LOCAL_USER.id
              : (project.current_user_id ?? Number(state.user?.id)),
          notifyAssignee: false,
          personalTask: true,
        })
      const pendingContentUpdate =
        (!previous ||
          previous.pendingContentUpdate ||
          previous.value.trim() !== content ||
          previous.requestedTitle !== title) &&
        (issue.description !== content || issue.title !== title)
      const saved = {
        ...drafts.get(projectKey),
        issue,
        value,
        requestedTitle: title,
        pendingContentUpdate,
        goalDraftActive,
        attachments: selectedAttachments.map(attachment => {
          const stored = { ...attachment }
          delete stored.local_preview_url
          return stored
        }),
      }
      drafts.set(projectKey, saved)
      if (pendingContentUpdate) {
        issue = await persistIssueDetailFields(issue, { title, description: content }, api.issues)
        drafts.set(projectKey, { ...saved, issue, pendingContentUpdate: false })
      }
      const runtimeContext = buildWorkItemRuntimeContext(
        project as unknown as CloudProject,
        issue as unknown as CloudLoopItem
      )
      const address = await workbench.createProjectRuntimeTask(content, {
        project: state.currentProject,
        deviceWorkspaceId: state.selectedDeviceWorkspaceId,
        attachments: selectedAttachments,
        ...(goalDraftActive
          ? { initialGoal: { objective: content, status: 'active' as const } }
          : {}),
        ...runtimeContext,
        origin: {
          ...runtimeContext.origin!,
          generatedIssueTitle: issue.title,
        },
        onError: setError,
        prepareRuntimeTask: address =>
          prepareIssueRuntimeTask({
            port,
            project,
            address,
            issueId: issue.id,
            title: issue.title,
            dispatchRoundId: issue.human_task_binding?.dispatchRoundId,
            issues: api.issues,
            onStatusError: error => setError(error || t('task_board_status_update_failed')),
          }),
      })
      if (!address) return false
      draft.onTaskCreated?.(issue, toWorkspaceRuntimeTaskAddress(address))
      session.complete(value)
      draft.onChange('')
      draft.onResetDraft?.()
      attachments.resetAttachments()
      drafts.delete(projectKey)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      submittingRef.current = false
      setSubmitting(false)
      draft.onPendingChange?.(false)
    }
  }
  return (
    <>
      {savedIssue && (
        <div
          className="mb-2 flex min-w-0 items-center justify-between gap-3 text-sm text-text-secondary"
          data-testid="personal-home-task-draft"
          data-issue-id={savedIssue.id}
        >
          <span className="truncate">
            {t('personalHome.savedTaskDraft', { title: savedIssue.title })}
          </span>
          <ControlButton
            variant="unstyled"
            type="button"
            disabled={submitting}
            data-testid="personal-home-new-task-draft"
            className="min-h-11 shrink-0 rounded-md px-2 hover:bg-muted hover:text-text-primary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-[color-mix(in_srgb,rgb(var(--color-focus-ring))_80%,rgb(var(--color-text-primary))_20%)] md:min-h-8"
            onClick={() => {
              if (projectKey) drafts.delete(projectKey)
              refreshDraft(value => value + 1)
              setError(null)
            }}
          >
            {t('personalHome.newTaskDraft')}
          </ControlButton>
        </div>
      )}
      <BufferedChatInput
        inputRef={input}
        autoFocus
        value={taskDraft.value}
        onDraftEdit={session.recordEdit}
        onChange={value => {
          setError(null)
          cacheDraft(value)
          draft.onChange(value)
        }}
        onSubmit={submit}
        disabled={submitting || draft.active === false}
        submitDisabled={
          !projectChat.isModelSelectionReady ||
          !attachments.isAttachmentReadyToSend ||
          attachments.errors.size > 0
        }
        error={error}
        placeholder={t('workbench.input_placeholder')}
        variant="desktop"
        inputTestId="personal-home-task-content"
        submitButtonTestId="personal-home-start-task"
        projectChat={{
          ...projectChat,
          ...attachments,
          attachments: taskDraft.attachments.attachments,
          uploadingFiles: taskDraft.attachments.uploadingFiles,
          errors: taskDraft.attachments.errors,
          removeAttachment: removeTaskAttachment,
          scopeKey,
          isOptionsLocked: false,
        }}
        projectWork={projectWork}
        projectWorkBarMiddleContext={draft.projectControl}
        workspaceTarget={workspaceTarget}
        workspaceFileApi={workbench.workspaceFileApi}
        goalDraftActive={goalDraftActive}
        onSetGoal={() => session.setGoal(true)}
        onCancelGoalDraft={() => session.setGoal(false)}
      />
    </>
  )
}
