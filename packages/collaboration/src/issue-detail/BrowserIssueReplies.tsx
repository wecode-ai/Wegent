import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ProjectChatClient, ProjectChatMessage } from '@wegent/chat-core'
import type { RuntimeTaskAddress } from '@wegent/chat-core/runtime'
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
import { groupIssueActivityThreads } from './IssueActivityThread'
import { issueCommentBody } from './useIssueCommentAttachments'
import { useBrowserIssueExecution } from './browserIssueExecutionContext'
import { useBrowserReplyQueueStore } from './browserTaskDraftContext'

import { BrowserIssueRepliesContext } from './browserIssueRepliesContext'

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
  const cards = useMemo(() => groupIssueActivityThreads(messages), [messages])
  const [activity, setActivity] = useState<Record<string, boolean>>({})
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null)
  const [subscriptionRevision, setSubscriptionRevision] = useState(0)
  const [subscribed, setSubscribed] = useState<{
    runtime: SharedWorkspaceRuntimeApi
    addressKeys: string
    revision: number
  } | null>(null)
  const refreshExecution = execution.retry
  const addressKeys = JSON.stringify([
    ...new Map(
      cards.flatMap(card => {
        const address = cardSessionAddress(card)
        return address ? [[`${address.deviceId}:${address.taskId}`, address] as const] : []
      })
    ).values(),
  ])
  useEffect(() => {
    if (serverExecution) return
    let active = true
    const cleanups: (() => void)[] = []
    const addresses: RuntimeTaskAddress[] = JSON.parse(addressKeys)
    void Promise.all(
      addresses.map(async address => {
        const key = `${address.deviceId}:${address.taskId}`
        const update = (running: boolean) => {
          if (active) setActivity(current => ({ ...current, [key]: running }))
        }
        const cleanup = await runtime.subscribe(address, {
          onMessageAction: () => {},
          onAssistantStart: () => update(true),
          onAssistantSettled: () => update(false),
          onHistoryInvalidated: () => {
            if (active) {
              setActivity(current => {
                const next = { ...current }
                delete next[key]
                return next
              })
              refreshExecution()
              setSubscriptionRevision(value => value + 1)
            }
          },
        })
        if (active) cleanups.push(cleanup)
        else cleanup()
      })
    )
      .then(() => {
        if (active) {
          setSubscriptionError(null)
          setSubscribed({ runtime, addressKeys, revision: subscriptionRevision })
          refreshExecution()
        }
      })
      .catch(cause => {
        if (active) setSubscriptionError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      active = false
      cleanups.forEach(cleanup => cleanup())
    }
  }, [runtime, addressKeys, subscriptionRevision, refreshExecution, serverExecution])
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
          subscribed?.runtime === runtime &&
          subscribed.addressKeys === addressKeys &&
          subscribed.revision === subscriptionRevision &&
          !execution.catalogError &&
          !subscriptionError)),
    busy: card =>
      cardSessionActive(card, address => {
        if (serverExecution) return undefined
        const key = `${address.deviceId}:${address.taskId}`
        return activity[key] ?? findRuntimeTask(execution.work, address)?.running ?? undefined
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
        error: serverExecution ? null : (subscriptionError ?? execution.catalogError),
        retry: () => {
          execution.retry()
          setSubscriptionRevision(value => value + 1)
        },
      }}
    >
      {children}
    </BrowserIssueRepliesContext.Provider>
  )
}
