import { useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { ProjectChatClient, ProjectChatMessage } from '@wegent/chat-core'
import { subscribeIdleResource } from '@wegent/chat-core/async-resource'
import { findRuntimeTask } from '@wegent/chat-core/runtime-task-lookup'
import type { SharedWorkspaceApi, SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationAgent, CollaborationIssue, CollaborationProject } from '../types'
import type { CollaborationTranslate } from '../i18n'
import {
  cardSessionAddress,
  cardSessionActive,
  dispatchTaskCardReply,
} from '../execution/taskCardReply'
import { useTaskReplyQueue } from '../execution/useTaskReplyQueue'
import {
  createHttpCommentRuntime,
  type CommentExecutionTarget,
} from '../execution/httpCommentRuntime'
import { groupIssueTimelineThreads } from './IssueActivityThread'
import { issueCommentBody } from './useIssueCommentAttachments'
import { useBrowserIssueExecution } from './browserIssueExecutionContext'
import { useBrowserReplyQueueStore } from './browserTaskDraftContext'

import { BrowserIssueRepliesContext } from './browserIssueRepliesContext'
import { createIssueReplyActivityResource, replyActivityKey } from './issueReplyActivityResource'

export function BrowserIssueReplies({
  runtime,
  api,
  client,
  project,
  issue,
  agents,
  messages,
  onMessages,
  onTaskUpdated,
  onReplyPersisted,
  canComment,
  translate: t,
  children,
}: {
  runtime: SharedWorkspaceRuntimeApi
  api: Pick<SharedWorkspaceApi, 'attachments' | 'taskBindings' | 'issues'>
  client: ProjectChatClient
  project: CollaborationProject
  issue: CollaborationIssue
  agents: CollaborationAgent[]
  messages: ProjectChatMessage[]
  onMessages(messages: ProjectChatMessage[]): void
  onTaskUpdated?(issue: CollaborationIssue): void
  onReplyPersisted?(rootId: string): void
  canComment: boolean
  translate: CollaborationTranslate
  children: ReactNode
}) {
  const store = useBrowserReplyQueueStore()
  const execution = useBrowserIssueExecution()
  const serverExecution = project.project_store === 'backend' && Boolean(client.executeTaskComment)
  const cards = useMemo(() => groupIssueTimelineThreads(messages), [messages])
  const refreshExecution = execution.retry
  const addressKeys = JSON.stringify([
    ...new Map(
      cards.flatMap(card => {
        const address = cardSessionAddress(card)
        return address ? [[replyActivityKey(address), address] as const] : []
      })
    ).values(),
  ])
  const activityResource = useMemo(
    () => createIssueReplyActivityResource(runtime, JSON.parse(addressKeys), refreshExecution),
    [runtime, addressKeys, refreshExecution]
  )
  const activitySnapshot = useSyncExternalStore(
    serverExecution ? subscribeIdleResource : activityResource.subscribe,
    activityResource.getSnapshot,
    activityResource.getSnapshot
  )
  const agent = agents.find(
    agent => agent.id === issue.assignee_agent_id && agent.status === 'active'
  )
  const queue = useTaskReplyQueue({
    store,
    scope: `issue-replies:${project.id}:${issue.id}`,
    cards,
    enabled:
      canComment &&
      (serverExecution ||
        (execution.catalogCurrent &&
          activitySnapshot.ready &&
          !execution.catalogError &&
          !activitySnapshot.error)),
    busy: card =>
      cardSessionActive(card, address => {
        if (serverExecution) return undefined
        const key = replyActivityKey(address)
        return (
          activitySnapshot.activity[key] ??
          findRuntimeTask(execution.work, address)?.running ??
          undefined
        )
      }),
    async dispatch(card, reply) {
      const address = cardSessionAddress(card)
      const task = address ? findRuntimeTask(execution.work, address) : null
      const target: CommentExecutionTarget | null = address
        ? {
            deviceId: address.deviceId,
            runtime: task?.runtime ?? address.runtime ?? 'codex',
            workspacePath: task?.workspacePath ?? address.workspacePath ?? undefined,
          }
        : execution.standaloneTarget
      return dispatchTaskCardReply({
        client,
        project,
        task: issue,
        agent,
        card,
        reply,
        messages,
        runtime: createHttpCommentRuntime(runtime.work, target),
        executionProject: target,
        services: {
          deliveryApi: { ...api.taskBindings, getLoopItem: api.issues.get },
          chatStream: { subscribe: runtime.subscribeChatStream },
        },
        prepareComment: async (text, attachments) =>
          issueCommentBody(
            text,
            attachments.length
              ? await api.attachments.importContexts(
                  issue.id,
                  attachments.map(file => file.id)
                )
              : []
          ),
        onMessages,
        onTaskUpdated,
        onPersisted: () => onReplyPersisted?.(card.root.messageId),
        onError: error =>
          store.setError(`issue-replies:${project.id}:${issue.id}:${card.root.messageId}`, error),
        startFailedText: t('workbench.project_chat_agent_start_failed'),
        sendFailedText: t('workbench.project_chat_send_failed'),
      })
    },
    sendFailedText: t('workbench.project_chat_send_failed'),
  })
  return (
    <BrowserIssueRepliesContext.Provider
      value={{
        queue,
        error: serverExecution ? null : (activitySnapshot.error ?? execution.catalogError),
        retry: () => {
          if (!serverExecution && !activitySnapshot.ready) activityResource.reload()
          else execution.retry()
        },
      }}
    >
      {children}
    </BrowserIssueRepliesContext.Provider>
  )
}
