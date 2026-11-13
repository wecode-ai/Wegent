import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { persistIssueDetailFields, type SharedWorkspaceApi } from '@wegent/collaboration'
import type { IssueHomeTaskComposerProps } from '@wegent/collaboration/platform'
import { truncateRuntimeTaskTitle } from '@wegent/chat-core/runtime-task-title'
import { BufferedChatInput } from '@/components/layout/BufferedChatInput'
import type { ProjectWorkControls } from '@/components/chat/ChatInput'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useWorkbenchAttachments } from '@/features/workbench/useWorkbenchAttachments'
import { toWorkspaceRuntimeTaskAddress } from '@/features/workbench/projectTaskTracking'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { resolveProjectRuntimeWorkspaceTarget } from '@/lib/workspace-target'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { buildWorkItemRuntimeContext } from './workItemRuntimeContext'
import { issueRuntimePort } from './issueRuntimePort'
import { prepareIssueRuntimeTask } from './prepareIssueRuntimeTask'
import { updateIssueWhenPersonalTaskStarts } from './workItemTaskInput'
import { LOCAL_USER } from '@/api/local/localSession'
import type { PersonalHomeTaskDrafts } from './personalHomeTaskDrafts'

/** Use the Tasks composer and its real controls; only the Issue linkage belongs here. */
export function PersonalHomeTaskComposer({
  draft,
  api,
  services,
  drafts,
}: {
  draft: IssueHomeTaskComposerProps
  api: SharedWorkspaceApi
  services: WorkbenchServices
  drafts: PersonalHomeTaskDrafts
}) {
  const { t } = useTranslation('common')
  const workbench = useWorkbench()
  const { state, projectChat } = workbench
  const scopeKey = useId()
  const attachments = useWorkbenchAttachments({
    scopeKey,
    uploadAttachment: services.attachmentApi?.uploadAttachment,
    deleteAttachment: services.attachmentApi?.deleteAttachment,
  })
  const uploaded = useRef(new Set<File>())
  const [error, setError] = useState<string | null>(null)
  const { handleTrackedFileSelect, removeSourceFile } = attachments
  useEffect(() => {
    const selected = new Set(draft.pendingFiles ?? [])
    for (const file of uploaded.current) {
      if (!selected.has(file)) {
        uploaded.current.delete(file)
        void removeSourceFile(file).catch(cause => setError(String(cause)))
      }
    }
    const files = [...selected].filter(file => !uploaded.current.has(file))
    files.forEach(file => uploaded.current.add(file))
    if (files.length) void handleTrackedFileSelect(files)
  }, [draft.pendingFiles, handleTrackedFileSelect, removeSourceFile])
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const project = draft.projects.find(item => item.id === draft.projectId)
  const projectKey = project ? `${project.project_store}:${project.id}` : null
  const savedDraft = projectKey ? drafts.get(projectKey) : undefined
  const [goalDraftActive, setGoalDraftActive] = useState(() => savedDraft?.goalDraftActive ?? false)
  const [, refreshDraft] = useState(0)
  const restored = useRef(false)
  const { addExistingAttachment } = attachments
  const { value: draftValue, onChange: onDraftChange } = draft
  useLayoutEffect(() => {
    if (restored.current || !projectKey) return
    restored.current = true
    const saved = drafts.get(projectKey)
    if (!saved) return
    if (!draftValue) onDraftChange(saved.value)
    if (!attachments.attachments.length) saved.attachments.forEach(addExistingAttachment)
  }, [
    projectKey,
    drafts,
    draftValue,
    onDraftChange,
    attachments.attachments.length,
    addExistingAttachment,
  ])
  const projectWork: ProjectWorkControls = {
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
    onSelectProject: workbench.selectProject,
    onSelectStandaloneDevice: workbench.selectStandaloneDevice,
    onSelectProjectWorkspace: workbench.selectProjectWorkspace,
    onBindProjectWorkspace: workbench.selectProject,
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
    const selectedAttachments = attachments.getSelectedAttachments(draft.pendingFiles ?? [])
    const port = project && issueRuntimePort(project.project_store, services)
    if (
      (!content && selectedAttachments.length === 0) ||
      !project ||
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
      let issue = previous ? await api.issues.get(previous.issue.id) : undefined
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
          }),
      })
      if (!address) return false
      const statusError = await updateIssueWhenPersonalTaskStarts(api.issues, issue.id)
      if (statusError !== null) setError(statusError || t('task_board_status_update_failed'))
      draft.onTaskCreated?.(issue, toWorkspaceRuntimeTaskAddress(address))
      draft.onChange('')
      draft.onResetDraft?.()
      attachments.resetAttachments()
      drafts.delete(projectKey)
      uploaded.current.clear()
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
      {savedDraft && (
        <div
          className="mb-2 flex min-w-0 items-center justify-between gap-3 text-sm text-text-secondary"
          data-testid="personal-home-task-draft"
          data-issue-id={savedDraft.issue.id}
        >
          <span className="truncate">
            {t('personalHome.savedTaskDraft', { title: savedDraft.issue.title })}
          </span>
          <button
            type="button"
            disabled={submitting}
            data-testid="personal-home-new-task-draft"
            className="min-h-8 shrink-0 rounded-md px-2 hover:bg-muted hover:text-text-primary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30"
            onClick={() => {
              if (projectKey) drafts.delete(projectKey)
              refreshDraft(value => value + 1)
              setError(null)
            }}
          >
            {t('personalHome.newTaskDraft')}
          </button>
        </div>
      )}
      <BufferedChatInput
        inputRef={draft.ref}
        autoFocus
        value={draft.value}
        onChange={value => {
          setError(null)
          draft.onChange(value)
        }}
        onSubmit={submit}
        disabled={submitting}
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
          removeAttachment: removeTaskAttachment,
          scopeKey,
          isOptionsLocked: false,
        }}
        projectWork={projectWork}
        projectWorkBarMiddleContext={draft.projectControl}
        workspaceTarget={workspaceTarget}
        workspaceFileApi={workbench.workspaceFileApi}
        goalDraftActive={goalDraftActive}
        onSetGoal={() => setGoalDraftActive(true)}
        onCancelGoalDraft={() => setGoalDraftActive(false)}
      />
    </>
  )
}
