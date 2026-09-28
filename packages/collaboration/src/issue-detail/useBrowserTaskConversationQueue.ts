import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { RuntimeTaskAddress } from '@wegent/chat-core/runtime'
import type { RuntimeTaskSummary } from '@wegent/chat-core/runtime-task-api-types'
import type { createRuntimeConversationSession } from '@wegent/chat-core/runtime-conversation-session'
import type { SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationTranslate } from '../i18n'
import { useBrowserConversationQueue } from './browserTaskDraftContext'
import { runtimeContinuationRequest } from '../execution/runtimeContinuationRequest'
import { createRuntimeUserMessage } from '../execution/runtimeUserMessage'
import { createAppliedRuntimeGuidanceMessage } from '../execution/runtimeGuidanceMessages'
import {
  runtimeQueuedMessageRequest,
  isRuntimeQueueBusyError,
  type RuntimeConversationQueuePort,
} from '../execution/runtimeConversationQueue'

type Session = ReturnType<typeof createRuntimeConversationSession>
function lifecycle(session: Session) {
  const state = session.getSnapshot()
  const lastTurn = state.turns.filter(turn => turn.id !== null).at(-1)
  return JSON.stringify([
    state.lifecycleRevision,
    state.running,
    state.runStatus,
    lastTurn?.id,
    lastTurn?.status,
  ])
}

/** Browser transports around the exact queue controller used by the PC panel. */
export function useBrowserTaskConversationQueue({
  runtime,
  address,
  task,
  session,
  projectId,
  running,
  sending,
  translate: t,
}: {
  runtime: SharedWorkspaceRuntimeApi
  address: RuntimeTaskAddress
  task: RuntimeTaskSummary | null
  session: Session
  projectId: string
  running: boolean
  sending: boolean
  translate: CollaborationTranslate
}) {
  const queue = useBrowserConversationQueue(`${address.deviceId}:${address.taskId}`)
  const messages = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot)
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  const port = useMemo<RuntimeConversationQueuePort<string>>(
    () => ({
      lifecycle: () => lifecycle(session),
      lifecycleChanged: previous => previous !== lifecycle(session),
      isBusyError: error =>
        isRuntimeQueueBusyError(error, t('workbench.runtime_task_running_message')),
      sendFailedText: t('workbench.project_chat_send_failed'),
      guidanceFailedText: t('workbench.project_chat_send_failed'),
      async send(message) {
        if (!task) throw new Error(t('activity.task_conversation_unavailable'))
        const request = runtimeQueuedMessageRequest(
          runtimeContinuationRequest(address, task, null, projectId),
          message
        )
        const previousTurns = new Set(
          session.getSnapshot().turns.flatMap(turn => (turn.id ? [turn.id] : []))
        )
        const result = await runtime.work.sendRuntimeMessage(request)
        if (result.accepted) {
          session.acceptUserMessage(
            createRuntimeUserMessage(message.content, message.attachments, { id: message.id }),
            previousTurns,
            result.turnId ?? result.turn_id
          )
          await session.reload()
        }
        return { sent: result.accepted, error: result.error }
      },
      async guide(message) {
        if (!task) throw new Error(t('activity.task_conversation_unavailable'))
        const request = runtimeQueuedMessageRequest(
          runtimeContinuationRequest(address, task, null, projectId),
          message
        )
        const result = await runtime.work.guideRuntimeTask({
          address: request.address,
          message: request.message,
          clientGuidanceId: message.id,
          ...(request.attachmentIds ? { attachmentIds: request.attachmentIds } : {}),
          ...(request.attachments ? { attachments: request.attachments } : {}),
        })
        return {
          sent: result.accepted === true || (result.accepted !== false && result.success === true),
          error: result.error,
        }
      },
    }),
    [runtime, address, task, session, projectId, t]
  )
  useEffect(
    () =>
      session.subscribeGuidance(payload => {
        const message = queue.applyGuidance(payload)
        if (message)
          session.applyGuidance(
            createAppliedRuntimeGuidanceMessage(message, payload),
            payload.subtaskId
          )
      }),
    [session, queue]
  )
  useEffect(() => {
    queue.reconcileGuidance(
      new Set(
        state.messages
          .filter(message => message.role === 'user' && message.runtimeGuidance)
          .map(message => message.id)
      )
    )
  }, [queue, state.messages])
  useEffect(() => {
    if (task && !state.loading && !state.error) void queue.pump(port, running || sending)
  }, [
    queue,
    port,
    task,
    running,
    sending,
    messages,
    state.loading,
    state.error,
    state.lifecycleRevision,
    state.running,
    state.runStatus,
    state.turns,
  ])
  return {
    queue,
    messages,
    isBusyError: port.isBusyError,
    lifecycle: port.lifecycle,
    guide: (id: string, force = false) => queue.guide(id, port, running || force),
  }
}
