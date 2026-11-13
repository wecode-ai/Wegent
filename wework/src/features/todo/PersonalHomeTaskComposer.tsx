import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { persistIssueDetailFields, type SharedWorkspaceApi } from '@wegent/collaboration'
import type { IssueHomeTaskComposerProps } from '@wegent/collaboration/platform'
import { truncateRuntimeTaskTitle } from '@wegent/chat-core/runtime-task-title'
import { BufferedChatInput } from '@/components/layout/BufferedChatInput'
import type { ChatInputHandle, ProjectWorkControls } from '@/components/chat/ChatInput'
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
import type { PersonalHomeTaskDraft, PersonalHomeTaskDrafts } from './personalHomeTaskDrafts'

interface PersonalHomeTaskComposerProps {
  draft: IssueHomeTaskComposerProps
  api: SharedWorkspaceApi
  services: WorkbenchServices
  drafts: PersonalHomeTaskDrafts
}

export function PersonalHomeTaskComposer(props: PersonalHomeTaskComposerProps) {
  const project = props.draft.projects.find(item => item.id === props.draft.projectId)
  const key = project ? `${project.project_store}:${project.id}` : ''
  const [selection, setSelection] = useState(() => ({ key, initial: props.drafts.get(key) }))
  if (selection.key !== key) {
    const previous = props.drafts.get(selection.key)
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
    setSelection({ key, initial })
    return <ProjectTaskComposer key={key} {...props} initial={initial} />
  }
  return <ProjectTaskComposer key={key} {...props} initial={selection.initial} />
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
  useImperativeHandle(
    draft.ref,
    () => ({
      get element() {
        return input.current?.element ?? null
      },
      focus: () => input.current?.focus(),
      getValue: () => input.current?.getValue() ?? draft.value,
      setValue: (value, offset) => input.current?.setValue(value, offset),
      insertReference: reference => input.current?.insertReference(reference),
    }),
    [draft.value]
  )
  const attachments = useWorkbenchAttachments({
    scopeKey,
    uploadAttachment: services.attachmentApi?.uploadAttachment,
    deleteAttachment: services.attachmentApi?.deleteAttachment,
  })
  const uploaded = useRef(new Set(initial?.attachmentFiles?.values()))
  const restoringFiles = useRef(initial ? (initial.pendingFiles ?? []) : undefined)
  const [error, setError] = useState<string | null>(null)
  const { handleTrackedFileSelect, removeSourceFile } = attachments
  useEffect(() => {
    if (draft.active === false) return
    const restoring = restoringFiles.current
    if (
      restoring &&
      restoring.length === (draft.pendingFiles?.length ?? 0) &&
      restoring.every(file => draft.pendingFiles?.includes(file))
    )
      restoringFiles.current = undefined
    const selected = new Set(restoring ?? draft.pendingFiles ?? [])
    for (const file of uploaded.current) {
      if (!selected.has(file)) {
        uploaded.current.delete(file)
        void removeSourceFile(file).catch(cause => setError(String(cause)))
      }
    }
    const files = [...selected].filter(file => !uploaded.current.has(file))
    files.forEach(file => uploaded.current.add(file))
    if (files.length) void handleTrackedFileSelect(files)
  }, [draft.active, draft.pendingFiles, handleTrackedFileSelect, removeSourceFile])
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const project = draft.projects.find(item => item.id === draft.projectId)
  const projectKey = project ? `${project.project_store}:${project.id}` : null
  const savedDraft = projectKey ? drafts.get(projectKey) : undefined
  const savedIssue = savedDraft?.issue
  const [goalDraftActive, setGoalDraftActive] = useState(() => initial?.goalDraftActive ?? false)
  const [, refreshDraft] = useState(0)
  const restored = useRef(false)
  const firstCapture = useRef(true)
  const { addExistingAttachment, addExistingSourceAttachment } = attachments
  const { onChange: onDraftChange } = draft
  const [source, setSource] = useState(() => ({
    value: draft.value,
    restored: initial?.value ?? draft.value,
  }))
  if (source.value !== draft.value) setSource({ value: draft.value, restored: draft.value })
  useLayoutEffect(() => {
    if (draft.active === false || restored.current || !projectKey) return
    restored.current = true
    const saved = initial
    if (!saved) return
    firstCapture.current = true
    onDraftChange(saved.value)
    input.current?.setValue(saved.value)
    for (const file of draft.pendingFiles ?? []) draft.onRemovePendingFile(file)
    if (saved.pendingFiles?.length) draft.onFileSelect(saved.pendingFiles)
    if (!attachments.attachments.length)
      saved.attachments.forEach(attachment => {
        const file = saved.attachmentFiles?.get(attachment.id)
        if (file) addExistingSourceAttachment(attachment, file)
        else addExistingAttachment(attachment)
      })
  }, [
    projectKey,
    drafts,
    initial,
    draft,
    onDraftChange,
    attachments.attachments.length,
    addExistingAttachment,
    addExistingSourceAttachment,
  ])
  const completed = useRef<string | null>(null)
  const resetOnUnmount = useRef(attachments.resetAttachments)
  const mountGeneration = useRef(0)
  useLayoutEffect(() => {
    resetOnUnmount.current = attachments.resetAttachments
  })
  useEffect(() => {
    const lifecycle = mountGeneration
    const generation = ++lifecycle.current
    return () =>
      queueMicrotask(() => {
        if (lifecycle.current === generation) resetOnUnmount.current()
      })
  }, [])
  const cacheDraft = (value: string) => {
    if (!projectKey || draft.active === false) return
    if (completed.current !== null) {
      const resetApplied =
        !value.trim() &&
        attachments.attachments.length === 0 &&
        attachments.uploadingFiles.size === 0 &&
        !draft.pendingFiles?.length
      if (!resetApplied && (!value.trim() || value === completed.current)) return
      completed.current = null
    }
    const previous = drafts.get(projectKey)
    const pendingFiles = [
      ...new Set([
        ...(restoringFiles.current ?? draft.pendingFiles ?? []),
        ...[...attachments.uploadingFiles.values()].map(upload => upload.file),
      ]),
    ]
    const selected = attachments.getSelectedAttachments(pendingFiles)
    const attachmentFiles = new Map<number, File>()
    selected.forEach(attachment => {
      const file = attachments.getSourceFile(attachment.id)
      if (file) attachmentFiles.set(attachment.id, file)
    })
    if (
      !previous?.issue &&
      !value.trim() &&
      !selected.length &&
      !pendingFiles.length &&
      !goalDraftActive
    ) {
      drafts.delete(projectKey)
      return
    }
    drafts.set(projectKey, {
      ...previous,
      value,
      requestedTitle: previous?.requestedTitle ?? '',
      pendingContentUpdate: Boolean(
        previous?.pendingContentUpdate || (previous?.issue && previous.value !== value)
      ),
      attachments: selected.map(attachment => {
        const copy = { ...attachment }
        delete copy.local_preview_url
        return copy
      }),
      pendingFiles: [...pendingFiles],
      attachmentFiles,
      goalDraftActive,
    })
  }
  useLayoutEffect(() => {
    if (draft.active === false) return
    if (firstCapture.current) {
      firstCapture.current = false
      return
    }
    cacheDraft(input.current?.getValue() ?? source.restored)
  })
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
    const selectedAttachments = attachments.getSelectedAttachments(
      restoringFiles.current ?? draft.pendingFiles ?? []
    )
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
          }),
      })
      if (!address) return false
      const statusError = await updateIssueWhenPersonalTaskStarts(api.issues, issue.id)
      if (statusError !== null) setError(statusError || t('task_board_status_update_failed'))
      draft.onTaskCreated?.(issue, toWorkspaceRuntimeTaskAddress(address))
      completed.current = value
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
      {savedIssue && (
        <div
          className="mb-2 flex min-w-0 items-center justify-between gap-3 text-sm text-text-secondary"
          data-testid="personal-home-task-draft"
          data-issue-id={savedIssue.id}
        >
          <span className="truncate">
            {t('personalHome.savedTaskDraft', { title: savedIssue.title })}
          </span>
          <button
            type="button"
            disabled={submitting}
            data-testid="personal-home-new-task-draft"
            className="min-h-11 shrink-0 rounded-md px-2 hover:bg-muted hover:text-text-primary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30 md:min-h-8"
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
        inputRef={input}
        autoFocus
        value={source.restored}
        onDraftEdit={value => cacheDraft(value)}
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
