import { useRef, useState, type ReactNode } from 'react'
import type { ModelOptions, UnifiedModel } from '@wegent/chat-core/models'
import type { RuntimeTaskAddress } from '@wegent/chat-core/runtime'
import { ProjectWorkBar } from '../controls/ProjectWorkBar'
import { ModelSelector } from '../controls/ModelSelector'
import {
  resolveAutomaticModel,
  selectedModelExecutionFields,
} from '../controls/runtimeModelSelection'
import { createHttpCommentRuntime } from '../execution/httpCommentRuntime'
import type { CollaborationTranslate } from '../i18n'
import { truncateRuntimeTaskTitle } from '@wegent/chat-core/runtime-task-title'
import { composerMarkdownText } from '../composer'
import { persistIssueDetailFields } from '../issue-detail/persistIssueDetailFields'
import { useBrowserCommentExecution } from '../issue-detail/useBrowserCommentExecution'
import { prepareIssueStartStatus } from '../issue-detail/prepareIssueStartStatus'
import { useMediaQuery } from '../media-query'
import type { SharedWorkspaceApi, SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationIssue, CollaborationProject } from '../types'
import { Button } from '../markdown/Button'

export type BrowserIssueHomeTaskDraft = {
  requestId: string
  issue?: CollaborationIssue
  boundTask?: RuntimeTaskAddress
  uploads: Map<File, Awaited<ReturnType<SharedWorkspaceRuntimeApi['uploadAttachment']>>>
}

export function BrowserIssueHomeTask({
  api,
  runtime,
  project,
  drafts,
  translate: t,
  onCreated,
  translateStatus,
  onPendingChange,
  render,
}: {
  api: SharedWorkspaceApi
  runtime: SharedWorkspaceRuntimeApi
  project: CollaborationProject
  drafts: Map<string, BrowserIssueHomeTaskDraft>
  translate: CollaborationTranslate
  onCreated(issue: CollaborationIssue, address: RuntimeTaskAddress, confirmed?: boolean): void
  translateStatus(key: string): string
  onPendingChange(pending: boolean): void
  render(input: {
    controls: ReactNode
    pending: boolean
    ready: boolean
    error: string | null
    submit(text: string, files: File[]): Promise<boolean>
  }): ReactNode
}) {
  const execution = useBrowserCommentExecution(runtime)
  const mobile = useMediaQuery('(max-width: 767px)')
  const [model, setModel] = useState<UnifiedModel | null>(null)
  const [options, setOptions] = useState<ModelOptions>({})
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const operation = useRef(false)
  const target = execution.target
  const selected = model
    ? (execution.models.find(
        item =>
          item.name === model.name &&
          item.type === model.type &&
          item.provider === model.provider &&
          item.namespace === model.namespace &&
          item.resourceUserId === model.resourceUserId
      ) ?? null)
    : resolveAutomaticModel(execution.models)
  const saved = drafts.get(project.id)
  const ready = Boolean(
    api.taskBindings &&
    target &&
    execution.catalogCurrent &&
    execution.modelsReady &&
    selected &&
    !saved?.boundTask
  )
  async function submit(text: string, files: File[]) {
    const bindings = api.taskBindings
    const title = truncateRuntimeTaskTitle(composerMarkdownText(text, { firstLine: true }) || text)
    if (!title || !ready || !target || !bindings || operation.current) return false
    operation.current = true
    setPending(true)
    onPendingChange(true)
    setError(null)
    const draft: BrowserIssueHomeTaskDraft = saved ?? {
      requestId: crypto.randomUUID(),
      uploads: new Map(),
    }
    drafts.set(project.id, draft)
    try {
      let issue =
        draft.issue ??
        (await api.issues.create(project.id, {
          requestId: draft.requestId,
          title,
          description: text,
          assigneeUserId: project.current_user_id,
          notifyAssignee: false,
          personalTask: true,
        }))
      draft.issue = issue
      if (issue.title !== title || issue.description !== text) {
        issue = await persistIssueDetailFields(issue, { title, description: text }, api.issues)
        draft.issue = issue
      }
      const attachments = []
      for (const file of files) {
        const attachment = draft.uploads.get(file) ?? (await runtime.uploadAttachment(file))
        draft.uploads.set(file, attachment)
        attachments.push(attachment)
      }
      const issueId = issue.id
      const task = await createHttpCommentRuntime(runtime.work, target).createProjectRuntimeTask(
        text,
        {
          cloudProjectId: project.id,
          origin: {
            type: 'board_task',
            cloudProjectId: project.id,
            loopItemId: issueId,
            projectStore: project.project_store,
            generatedIssueTitle: issue.title,
          },
          executionModel: selectedModelExecutionFields(selected, options),
          attachments,
          prepareRuntimeTask: async address => {
            await bindings.bindTask(issueId, address, issue.title)
            draft.boundTask = address
            const status = await prepareIssueStartStatus(api.issues, issueId, {
              projectStore: project.project_store,
            })
            if (status.error !== null) setError(status.error)
            return async () => {
              try {
                await status.rollback?.()
              } finally {
                await bindings.unbindTask(issueId, address)
                draft.boundTask = undefined
              }
            }
          },
          onError: message => setError(message),
        }
      )
      if (!task) {
        if (draft.boundTask) setError(translateStatus('issue_creation.launch_unconfirmed'))
        return false
      }
      drafts.delete(project.id)
      onCreated(issue, task)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      operation.current = false
      setPending(false)
      onPendingChange(false)
    }
  }

  const controls = (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="personal-home-task-execution-settings"
      aria-busy={
        execution.loading || (Boolean(target) && !execution.modelsReady && !execution.error)
      }
    >
      {execution.projects.length > 0 && (
        <ProjectWorkBar
          translate={t}
          isMobile={mobile}
          projects={execution.projects}
          devices={execution.devices}
          runtimeWork={execution.work}
          currentProject={execution.currentProject}
          currentProjectId={execution.selection?.projectId}
          selectedDeviceWorkspaceId={execution.workspace?.id}
          pendingProjectWorkspaceProjectId={
            execution.selection && !execution.workspace ? execution.selection.projectId : null
          }
          onSelectProject={id => execution.selectProject(id)}
          onSelectStandaloneDevice={() => execution.selectProject(null)}
          onSelectProjectWorkspace={(id, _workspaceId, workspace) =>
            execution.selectProject(id, workspace)
          }
        />
      )}
      <ModelSelector
        translate={t}
        isMobile={mobile}
        models={execution.models}
        selectedModel={selected}
        selectedModelOptions={options}
        disabled={pending || !execution.modelsReady}
        onSelectModel={setModel}
        onSelectModelOption={(id, value) => setOptions(current => ({ ...current, [id]: value }))}
        onOpenModelSettings={runtime.openModelSettings}
        onBlockedModelSelect={(_, message) => setError(message ?? t('todo.send_failed'))}
      />
      {execution.error && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="personal-home-task-retry-catalog"
          onClick={execution.retry}
        >
          {t('common.retry', '重试')}
        </Button>
      )}
      {saved?.issue && saved.boundTask && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="personal-home-task-open-bound"
          onClick={() => {
            if (saved.issue && saved.boundTask) onCreated(saved.issue, saved.boundTask, false)
          }}
        >
          {t('personalHome.viewTask', '查看任务')}
        </Button>
      )}
    </div>
  )
  return render({
    controls,
    pending,
    ready,
    error:
      error ??
      execution.error ??
      (!execution.loading && !target
        ? translateStatus('issue_creation.no_execution_device')
        : null),
    submit,
  })
}
