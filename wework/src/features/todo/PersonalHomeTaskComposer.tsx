import { useEffect, useId, useRef, useState } from 'react'
import {
  persistIssueDetailFields,
  type CollaborationIssue,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'
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
import { LOCAL_USER } from '@/api/local/localSession'

/** Use the Tasks composer and its real controls; only the Issue linkage belongs here. */
export function PersonalHomeTaskComposer({
  draft,
  api,
  services,
}: {
  draft: IssueHomeTaskComposerProps
  api: SharedWorkspaceApi
  services: WorkbenchServices
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
  const { handleFileSelect } = attachments
  useEffect(() => {
    const files = (draft.pendingFiles ?? []).filter(file => !uploaded.current.has(file))
    files.forEach(file => uploaded.current.add(file))
    if (files.length) void handleFileSelect(files)
  }, [draft.pendingFiles, handleFileSelect])
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [goalDraftActive, setGoalDraftActive] = useState(false)
  // A rejected runtime start retries the same Issue instead of creating a duplicate.
  const preparedIssues = useRef(new Map<string, CollaborationIssue>())
  const project = draft.projects.find(item => item.id === draft.projectId)
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
  const submit = async (value = draft.value) => {
    const content = value.trim()
    const port = project && issueRuntimePort(project.project_store, services)
    if (
      (!content && attachments.attachments.length === 0) ||
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
      let issue = preparedIssues.current.get(projectKey)
      const title =
        truncateRuntimeTaskTitle(
          content.replace(/\s+/g, ' ') ||
            attachments.attachments.map(file => file.filename).join('、')
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
      preparedIssues.current.set(projectKey, issue)
      if (issue.description !== content || issue.title !== title) {
        issue = await persistIssueDetailFields(issue, { title, description: content }, api.issues)
        preparedIssues.current.set(projectKey, issue)
      }
      const runtimeContext = buildWorkItemRuntimeContext(
        project as unknown as CloudProject,
        issue as unknown as CloudLoopItem
      )
      const address = await workbench.createProjectRuntimeTask(content, {
        project: state.currentProject,
        deviceWorkspaceId: state.selectedDeviceWorkspaceId,
        attachments: attachments.attachments,
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
            api,
            port,
            project,
            address,
            issueId: issue.id,
            title: issue.title,
            onStatusError: message => setError(message || t('task_board_status_update_failed')),
          }),
      })
      if (!address) return false
      draft.onTaskCreated?.(issue, toWorkspaceRuntimeTaskAddress(address))
      draft.onChange('')
      draft.onResetDraft?.()
      attachments.resetAttachments()
      preparedIssues.current.delete(projectKey)
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
    <BufferedChatInput
      inputRef={draft.ref}
      autoFocus
      value={draft.value}
      onChange={draft.onChange}
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
      projectChat={{ ...projectChat, ...attachments, scopeKey, isOptionsLocked: false }}
      projectWork={projectWork}
      projectWorkBarMiddleContext={draft.projectControl}
      workspaceTarget={workspaceTarget}
      workspaceFileApi={workbench.workspaceFileApi}
      goalDraftActive={goalDraftActive}
      onSetGoal={() => setGoalDraftActive(true)}
      onCancelGoalDraft={() => setGoalDraftActive(false)}
    />
  )
}
