import { useContext, useEffect, useRef, useState } from 'react'
import type { ProjectChatMessage } from '@wegent/chat-core'
import type { CollaborationAgent, CollaborationIssue, CollaborationProject } from '../types'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationTranslate } from '../i18n'
import { IssueActivityTools } from './IssueActivityTools'
import { canApproveIssueExecution } from './activityApproval'
import { BrowserIssueExecutionContext } from './browserIssueExecutionContext'
import { BrowserTaskDraftContext } from './browserTaskDraftContext'
import { createHttpCommentRuntime } from '../execution/httpCommentRuntime'
import {
  buildRobotRoleDescription,
  selectActivityRerunModel,
  startTaskAiRun,
} from '../execution/taskAiExecution'

/** Web effects for the PC activity tools; version and project identity stay explicit. */
export function BrowserIssueActivityTools({
  api,
  project,
  issue,
  agents,
  currentUserId,
  messages,
  onMessages,
  onTaskUpdated,
  translate: t,
}: {
  api: Pick<SharedWorkspaceApi, 'issues'> &
    Partial<Pick<SharedWorkspaceApi, 'runtime' | 'activity' | 'taskBindings'>>
  project?: CollaborationProject
  issue: CollaborationIssue
  agents: CollaborationAgent[]
  currentUserId?: string | number | null
  messages: ProjectChatMessage[]
  onMessages(messages: ProjectChatMessage[]): void
  onTaskUpdated?(issue: CollaborationIssue): void
  translate: CollaborationTranslate
}) {
  const execution = useContext(BrowserIssueExecutionContext)
  const drafts = useContext(BrowserTaskDraftContext)
  const operationScope = `issue:${issue.cloud_project_id}:${issue.id}`
  const agent = agents.find(
    agent => agent.id === issue.assignee_agent_id && agent.status === 'active'
  )
  const request = useRef<object | null>(null)
  const lifecycle = useRef<object | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    lifecycle.current = {}
    return () => {
      lifecycle.current = null
      request.current = null
    }
  }, [])
  async function perform(action: () => Promise<unknown>, failureKey: string) {
    if (request.current || (drafts && !drafts.operations.begin(operationScope))) return
    drafts?.update(operationScope, { busy: true, error: null })
    const token = {}
    request.current = token
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      if (request.current === token)
        setError(cause instanceof Error ? cause.message : t(failureKey))
    } finally {
      drafts?.operations.end(operationScope)
      drafts?.update(operationScope, { busy: false })
      if (request.current === token) {
        request.current = null
        setBusy(false)
      }
    }
  }
  async function update(action: () => Promise<CollaborationIssue>) {
    const token = request.current
    const updated = await action()
    if (request.current === token) onTaskUpdated?.(updated)
  }
  async function rerun() {
    if (!api.runtime || !api.activity || !api.taskBindings || !project || !agent || !execution)
      return
    const target = execution.standaloneTarget
    if (!target) throw new Error(t('activity.comment_execution_target_required'))
    const models =
      execution.target?.deviceId === target.deviceId && execution.modelsReady
        ? execution.models
        : await api.runtime.listModels(target.deviceId)
    const selectedModel = selectActivityRerunModel(messages, models)
    const token = lifecycle.current
    await startTaskAiRun({
      client: api.activity,
      project,
      task: issue,
      agent,
      prompt: buildRobotRoleDescription(agent),
      messages,
      services: {
        deliveryApi: { ...api.taskBindings, getLoopItem: api.issues.get },
        chatStream: { subscribe: api.runtime.subscribeChatStream },
      },
      runtime: createHttpCommentRuntime(api.runtime.work, target),
      executionProject: null,
      models,
      selectedModel,
      selectedModelOptions: {},
      onMessages: incoming => {
        if (lifecycle.current === token) onMessages(incoming)
      },
      onTaskUpdated: updated => {
        if (lifecycle.current === token) onTaskUpdated?.(updated)
      },
      onError: message => {
        if (lifecycle.current === token) setError(message)
      },
      startFailedText: t('workbench.project_chat_agent_start_failed'),
    })
  }
  return (
    <>
      <IssueActivityTools
        task={issue}
        assignedAgent={agent}
        running={busy || drafts?.drafts[operationScope]?.busy === true}
        translate={t}
        copyText={text => navigator.clipboard.writeText(text)}
        canApprove={canApproveIssueExecution(
          issue.can_approve,
          agent?.createdByUserId,
          currentUserId
        )}
        onApprove={() =>
          void perform(
            () =>
              update(() => api.issues.approveRun(issue.cloud_project_id, issue.id, issue.version)),
            'workbench.task_activity_approve_failed'
          )
        }
        onReject={() => {
          const reason = window.prompt(t('workbench.task_activity_reject_reason_prompt'))
          if (reason === null) return
          void perform(
            () =>
              update(() =>
                api.issues.rejectRun(
                  issue.cloud_project_id,
                  issue.id,
                  issue.version,
                  reason.trim() || undefined
                )
              ),
            'workbench.task_activity_reject_failed'
          )
        }}
        onAccept={() =>
          void perform(
            () =>
              update(() =>
                api.issues.update(issue.id, { version: issue.version, status: 'completed' })
              ),
            'workbench.task_activity_accept_failed'
          )
        }
        onRun={
          execution && api.runtime && api.activity && api.taskBindings && project
            ? () => void perform(rerun, 'workbench.project_chat_agent_start_failed')
            : undefined
        }
      />
      {error ? (
        <span role="alert" className="text-xs text-red-600">
          {error}
        </span>
      ) : null}
    </>
  )
}
