import { useIssueMentionGroups } from './useIssueMentionGroups'
import { useEffect, useMemo, useState } from 'react'
import type { ProjectChatClient, ProjectChatMessage } from '@wegent/chat-core'
import type { Attachment } from '@wegent/chat-core/runtime'
import {
  RUNTIME_PERMISSION_MODE_OPTION,
  runtimePermissionMode,
} from '@wegent/chat-core/runtime-permission'
import type { SharedWorkspaceApi, SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'
import type {
  CollaborationMember,
  CollaborationAgent,
  CollaborationIssue,
  CollaborationProject,
} from '../types'
import type { CollaborationTranslate } from '../i18n'
import { ModelSelector } from '../controls/ModelSelector'
import { PermissionModeSelector } from '../controls/PermissionModeSelector'
import { ProjectWorkBar } from '../controls/ProjectWorkBar'
import { resolveAutomaticModel } from '../controls/runtimeModelSelection'
import { createHttpCommentRuntime } from '../execution/httpCommentRuntime'
import { startTaskAiRun } from '../execution/taskAiExecution'
import { commentAgentMentions } from '../execution/taskCardReply'
import { useBrowserIssueExecution } from './browserIssueExecutionContext'
import { useBrowserTaskDraft } from './browserTaskDraftContext'
import { IssueMainCommentComposer } from './IssueMainCommentComposer'
import { ComposerAttachmentBadges } from './ComposerAttachmentBadges'
import type { IssueMentionOption } from './issueCommentMentions'
import type { AttachmentImageServices } from './AttachmentImageView'
import { issueCommentBody } from './useIssueCommentAttachments'

type CommentApi = Pick<SharedWorkspaceApi, 'attachments' | 'taskBindings' | 'issues'>

/** Browser services around the exact PC main composer, controls, uploads and execution orchestration. */
export function BrowserIssueCommentComposer({
  api,
  runtime,
  client,
  project,
  issue,
  agents,
  members,
  messages,
  canComment,
  canAttach,
  loading,
  translate: t,
  onMessages,
  onTaskUpdated,
  onCommentPersisted,
}: {
  api: CommentApi
  runtime: SharedWorkspaceRuntimeApi
  client: ProjectChatClient
  project: CollaborationProject
  issue: CollaborationIssue
  members: CollaborationMember[]
  agents: CollaborationAgent[]
  messages: ProjectChatMessage[]
  canComment: boolean
  canAttach: boolean
  loading: boolean
  translate: CollaborationTranslate
  onMessages(messages: ProjectChatMessage[]): void
  onCommentPersisted?(message: ProjectChatMessage): void
  onTaskUpdated?(issue: CollaborationIssue): void
}) {
  const mentionGroups = useIssueMentionGroups(members, agents, t)
  const draft = useBrowserTaskDraft(`issue:${project.id}:${issue.id}`)
  const execution = useBrowserIssueExecution()
  const serverExecution = project.project_store === 'backend' && client.executeTaskComment
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)')
    const update = () => setIsMobile(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const agent = agents.find(
    agent => agent.id === issue.assignee_agent_id && agent.status === 'active'
  )
  const selectedModel = draft.selection?.model ?? null
  const options = draft.selection?.options ?? {}
  const images = useMemo<AttachmentImageServices<Attachment>>(
    () => ({
      identity: file => String(file.id),
      async load(file) {
        if (file.local_preview_url) return { url: file.local_preview_url, release: null }
        const url = URL.createObjectURL(await runtime.readAttachment(file.id))
        return { url, release: () => URL.revokeObjectURL(url) }
      },
      async download(_file, url, filename) {
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = filename
        document.body.append(anchor)
        anchor.click()
        anchor.remove()
      },
    }),
    [runtime]
  )
  const setOption = (id: string, value: string) =>
    draft.setSelection({
      model: selectedModel,
      options: { ...options, [id]: value },
    })
  async function submit(mentions: IssueMentionOption[]) {
    const text = draft.draft.trim()
    if (
      !canComment ||
      loading ||
      !text ||
      !draft.attachments.isAttachmentReadyToSend ||
      !draft.beginOperation()
    )
      return
    const attachments = draft.attachments.attachments
    try {
      if (!serverExecution && agent && !execution.target)
        throw new Error(t('activity.comment_execution_target_required'))
      if (!serverExecution && agent && !execution.modelsReady)
        throw new Error(execution.error ?? t('activity.comment_models_loading'))
      if (
        !serverExecution &&
        selectedModel &&
        !execution.models.some(
          model =>
            model.name === selectedModel.name &&
            model.type === selectedModel.type &&
            model.provider === selectedModel.provider &&
            model.namespace === selectedModel.namespace &&
            model.resourceUserId === selectedModel.resourceUserId
        )
      )
        throw new Error(t('activity.comment_model_unavailable'))
      const model = selectedModel ?? resolveAutomaticModel(execution.models)
      const imported = attachments.length
        ? await api.attachments.importContexts(
            issue.id,
            attachments.map(file => file.id)
          )
        : []
      const message = await client.send({
        projectId: project.id,
        taskId: issue.id,
        clientMessageId: crypto.randomUUID(),
        text: issueCommentBody(text, imported),
        replyToMessageId: null,
        model: serverExecution ? null : (model?.name ?? null),
        mentions: [
          ...(serverExecution
            ? commentAgentMentions(text, agents)
            : agent
              ? [{ type: 'agent' as const, id: agent.id, label: agent.name }]
              : []),
          ...mentions.filter(mention => mention.type === 'user'),
        ],
      })
      onMessages([message])
      onCommentPersisted?.(message)
      // Persistence succeeded. A rejected execution must not cause a duplicate comment on retry.
      draft.setDraft('')
      draft.attachments.resetAttachments()
      if (serverExecution) {
        onMessages(
          await serverExecution({
            projectId: project.id,
            taskId: issue.id,
            triggerMessageId: message.messageId,
            attachmentIds: attachments.map(file => Number(file.id)),
          })
        )
      } else if (agent && execution.target)
        await startTaskAiRun({
          client,
          project,
          task: issue,
          agent,
          services: {
            deliveryApi: { ...api.taskBindings, getLoopItem: api.issues.get },
            chatStream: { subscribe: runtime.subscribeChatStream },
          },
          runtime: createHttpCommentRuntime(runtime.work, execution.target),
          executionProject: execution.target,
          prompt: text,
          trigger: message,
          messages,
          attachments,
          selectedModel: model,
          selectedModelOptions: options,
          onError: draft.setError,
          onMessages,
          onTaskUpdated,
          startFailedText: t('workbench.project_chat_agent_start_failed'),
        })
    } catch (cause) {
      draft.setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      draft.endOperation()
    }
  }
  return (
    <>
      {!serverExecution && execution.error && (
        <div role="alert" className="mb-2 text-xs text-error">
          {execution.error}
          <button
            type="button"
            className="ml-2 underline"
            data-testid="comment-execution-retry"
            onClick={execution.retry}
          >
            {t('activity.retry')}
          </button>
        </div>
      )}
      <IssueMainCommentComposer
        mentionGroups={mentionGroups}
        value={draft.draft}
        onChange={draft.setDraft}
        onSubmit={mentions => void submit(mentions)}
        disabled={!canComment || loading}
        sending={draft.busy}
        uploading={!draft.attachments.isAttachmentReadyToSend}
        error={draft.error}
        labels={{
          placeholder: t('workbench.task_activity_placeholder'),
          send: t('workbench.send_message'),
          attach: t('workbench.task_activity_attachment_attach'),
          settings: t('workbench.task_activity_execution_settings'),
        }}
        testIds={{
          form: 'collaboration-issue-comment-form',
          input: 'collaboration-issue-comment',
          send: 'collaboration-issue-comment-submit',
          settings: 'collaboration-comment-settings-toggle',
          file: 'collaboration-comment-attach-input',
          attach: 'collaboration-comment-attach',
          mentions: 'collaboration-issue-mention-popup',
        }}
        onSelectFiles={canAttach ? files => draft.attachments.handleFileSelect(files) : undefined}
        attachments={
          <ComposerAttachmentBadges
            {...draft.attachments}
            onRemoveAttachment={id => {
              void draft.attachments
                .removeAttachment(id)
                .catch(cause => draft.setError(String(cause)))
            }}
            imageServices={images}
            labels={{
              showText: t('todo.show_text_attachment'),
              addingText: t('todo.adding_pasted_text_attachment'),
              pastedText: t('todo.pasted_text_attachment'),
              appshot: t('todo.appshot_attachment'),
            }}
          />
        }
        settings={
          serverExecution ? undefined : (
            <>
              {execution.projects.length > 0 && (
                <ProjectWorkBar
                  translate={t}
                  isMobile={isMobile}
                  projects={execution.projects}
                  devices={execution.devices}
                  runtimeWork={execution.work}
                  currentProject={execution.currentProject}
                  currentProjectId={execution.selection?.projectId}
                  selectedDeviceWorkspaceId={execution.workspace?.id}
                  pendingProjectWorkspaceProjectId={
                    execution.selection && !execution.workspace
                      ? execution.selection.projectId
                      : null
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
                isMobile={isMobile}
                models={execution.models}
                selectedModel={selectedModel}
                selectedModelOptions={options}
                disabled={draft.busy || !execution.modelsReady}
                onSelectModel={model => draft.setSelection({ model, options })}
                onSelectModelOption={setOption}
                onOpenModelSettings={runtime.openModelSettings}
                onBlockedModelSelect={(_, message) =>
                  draft.setError(message ?? t('todo.send_failed'))
                }
              />
              <PermissionModeSelector
                translate={t}
                value={runtimePermissionMode(options)}
                disabled={draft.busy}
                onChange={mode => setOption(RUNTIME_PERMISSION_MODE_OPTION, mode)}
              />
            </>
          )
        }
      />
    </>
  )
}
