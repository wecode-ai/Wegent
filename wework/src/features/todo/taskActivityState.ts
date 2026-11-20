import { createE2ELifecycleTrace } from '@/e2e/lifecycleTrace'
import type { ProjectChatClient, ProjectChatMessage } from '@/api/backend/projectChatSocket'
import type {
  CloudLoopItem,
  CloudProject,
  LoopItemTaskBinding,
  createDeliveryApi,
} from '@/api/deliveries'
import type { ProjectChatAgent, createProjectChatAgentApi } from '@/api/projectChatAgents'
import type { useNotificationEntity } from '@/features/notifications/NotificationEntityContext'
import { notificationCommentFocus } from '@/features/notifications/notificationCommentFocus'
import { isVersionConflict } from './taskActivityHelpers'
import { isExecutionTerminal } from './executionStatus'
import { mergeProjectChatMessages } from './taskAiExecution'

type DeliveryApi = ReturnType<typeof createDeliveryApi> | undefined
type AgentApi = ReturnType<typeof createProjectChatAgentApi> | undefined
export interface TaskActivityInput {
  lifecycleTrace?: { issueTimeline: boolean; linear: boolean }
  task: CloudLoopItem
  bindings: LoopItemTaskBinding[]
  notification: ReturnType<typeof useNotificationEntity>
  devices: Parameters<typeof notificationCommentFocus>[3]
  store: CloudProject['project_store']
  onTaskRead?(task: CloudLoopItem): void
  onTaskUpdated?(task: CloudLoopItem): void
  onRefreshExecutionArtifacts?(): void | Promise<void>
  t(key: string): string
}
interface ActivitySnapshot {
  messages: ProjectChatMessage[]
  projectChatAgents: ProjectChatAgent[]
  chatCurrentUserId: string | null
  loading: boolean
  sending: boolean
  loadedVersion: number | null
  error: string | null
  readError: string | null
}

export function createTaskActivityState(
  client: ProjectChatClient | undefined,
  api: DeliveryApi,
  agentApi: AgentApi,
  projectId: string,
  issueId: string
) {
  const lifecycleTrace = createE2ELifecycleTrace('TaskActivityView')
  let snapshot: ActivitySnapshot = {
    messages: [],
    projectChatAgents: [],
    chatCurrentUserId: null,
    sending: false,
    loading: Boolean(client),
    loadedVersion: null,
    error: null,
    readError: null,
  }
  const observers = new Map<() => void, TaskActivityInput>()
  let input: TaskActivityInput | undefined
  let generation = 0
  let started = false
  let feedVersion: number | null = null
  let feedGeneration = 0
  let unsubscribeFeed: (() => void) | undefined
  let notificationKey: string | undefined
  let notificationCallback: ((messageId: string) => void) | undefined
  const pendingSends = new Set<object>()
  const refreshedRuns = new Set<string>()
  const requestedBindings = new Set<string>()
  const active = () => observers.size > 0
  const publish = (next: Partial<ActivitySnapshot>) => {
    snapshot = { ...snapshot, ...next }
    observers.forEach((_, listener) => listener())
  }
  const reportError = (error: string | null) => {
    if (active()) publish({ error })
  }
  function locateNotification() {
    const current = input
    const notification = current?.notification
    if (
      !current ||
      !notification ||
      notification.projectId !== projectId ||
      notification.issueId !== issueId ||
      notification.store !== current.store
    ) {
      notificationKey = undefined
      notificationCallback = undefined
      return
    }
    const commentId = notificationCommentFocus(
      snapshot.messages.filter(message => message.taskId === issueId),
      notification.address,
      notification.sourceMessageIds,
      current.devices
    )
    const key = JSON.stringify([notification.id, notification.sourceMessageIds, commentId])
    if (key === notificationKey && notification.onFocusedMessage === notificationCallback) return
    notificationKey = key
    notificationCallback = notification.onFocusedMessage
    console.debug('[Wework] Notification comment location resolved', {
      requestId: notification.id,
      sourceMessageIds: JSON.stringify(notification.sourceMessageIds ?? []),
      commentId,
    })
    if (commentId) notification.onFocusedMessage?.(commentId)
  }
  function refreshExecutionFacts() {
    const current = input
    if (!current || !active()) return
    const epoch = generation
    if (api?.getLoopItem && current.task.status !== 'completed') {
      const terminal = snapshot.messages.find(
        message =>
          message.taskId === issueId &&
          message.sender.type === 'agent' &&
          isExecutionTerminal(message.status) &&
          !refreshedRuns.has(message.messageId)
      )
      if (terminal) {
        refreshedRuns.add(terminal.messageId)
        console.info('[Wework] Task activity terminal AI message received; refreshing task', {
          taskId: issueId,
          messageId: terminal.messageId,
          messageStatus: terminal.status,
          runtimeDeviceId: terminal.runtimeAddress?.deviceId,
          runtimeTaskId: terminal.runtimeAddress?.taskId,
        })
        void Promise.all([
          api.getLoopItem(issueId).then(updated => {
            if (active() && generation === epoch) input?.onTaskUpdated?.(updated)
          }),
          Promise.resolve().then(() => {
            if (active() && generation === epoch) return input?.onRefreshExecutionArtifacts?.()
          }),
        ]).catch(cause => {
          if (active() && generation === epoch)
            reportError(
              cause instanceof Error
                ? cause.message
                : current.t('workbench.project_chat_load_failed')
            )
        })
      }
    }
    if (!current.onRefreshExecutionArtifacts) return
    const missing = snapshot.messages
      .flatMap(message =>
        message.sender.type === 'agent' && message.runtimeAddress ? [message.runtimeAddress] : []
      )
      .find(
        address =>
          !current.bindings.some(
            binding => binding.device_id === address.deviceId && binding.task_id === address.taskId
          ) && !requestedBindings.has(`${address.deviceId}:${address.taskId}`)
      )
    if (!missing) return
    const key = `${missing.deviceId}:${missing.taskId}`
    requestedBindings.add(key)
    void Promise.resolve()
      .then(() => {
        if (active() && generation === epoch) return input?.onRefreshExecutionArtifacts?.()
        requestedBindings.delete(key)
      })
      .catch(() => requestedBindings.delete(key))
  }
  function receiveMessages(incoming: ProjectChatMessage[]) {
    if (!active()) return
    publish({ messages: mergeProjectChatMessages(snapshot.messages, incoming) })
    locateNotification()
    refreshExecutionFacts()
  }
  function subscribeFeed() {
    if (!client || !input || feedVersion === input.task.version) return
    feedVersion = input.task.version
    const version = feedVersion
    const epoch = ++feedGeneration
    unsubscribeFeed?.()
    unsubscribeFeed = undefined
    const liveMessageIds = new Set<string>()
    void client
      .subscribe(
        projectId,
        issueId,
        0,
        message => {
          if (epoch !== feedGeneration || !active()) return
          if (!unsubscribeFeed) liveMessageIds.add(message.messageId)
          receiveMessages([message])
        },
        chunk => {
          if (epoch !== feedGeneration || !active()) return
          if (!unsubscribeFeed) liveMessageIds.add(chunk.messageId)
          const existing = snapshot.messages.find(message => message.messageId === chunk.messageId)
          receiveMessages([
            existing
              ? {
                  ...existing,
                  content:
                    chunk.metadata.contentMode === 'snapshot'
                      ? chunk.content
                      : `${existing.content}${chunk.content}`,
                  status: 'streaming',
                  updatedAt: chunk.updatedAt,
                }
              : chunk,
          ])
        }
      )
      .then(subscription => {
        if (epoch !== feedGeneration) {
          subscription.unsubscribe()
          return
        }
        unsubscribeFeed = subscription.unsubscribe
        const incoming = subscription.snapshot.messages
        const verifiedSourceIds = new Set(
          incoming.map(message => message.messageId).filter(id => !liveMessageIds.has(id))
        )
        liveMessageIds.clear()
        publish({
          chatCurrentUserId: subscription.snapshot.currentUserId,
          messages: mergeProjectChatMessages(snapshot.messages, incoming, verifiedSourceIds),
          loading: false,
          loadedVersion: version,
        })
        if (active()) {
          locateNotification()
          refreshExecutionFacts()
        }
      })
      .catch(cause => {
        if (epoch !== feedGeneration) return
        publish({
          loading: false,
          error:
            cause instanceof Error
              ? cause.message
              : (input?.t('workbench.project_chat_load_failed') ?? ''),
        })
      })
  }
  function start() {
    if (started) return
    started = true
    const epoch = generation
    if (agentApi)
      void agentApi
        .list(projectId)
        .then(projectChatAgents => {
          if (epoch === generation) publish({ projectChatAgents })
        })
        .catch(cause => {
          if (epoch === generation)
            reportError(
              cause instanceof Error
                ? cause.message
                : (input?.t('workbench.project_chat_agents_load_failed') ?? '')
            )
        })
  }
  async function changeTask(action: 'accept' | 'approve' | 'reject', reason?: string) {
    const current = input
    if (!api || !current || !active()) return
    const epoch = generation
    const isCurrent = () => active() && generation === epoch
    reportError(null)
    try {
      let updated: CloudLoopItem
      if (action === 'accept') {
        try {
          updated = await api.updateLoopItem(issueId, {
            version: current.task.version,
            status: 'completed',
          })
        } catch (cause) {
          if (!isVersionConflict(cause)) throw cause
          const latest = await api.getLoopItem(issueId)
          if (!isCurrent()) return
          updated =
            latest.status === 'completed'
              ? latest
              : await api.updateLoopItem(issueId, {
                  version: latest.version,
                  status: 'completed',
                })
        }
      } else if (action === 'approve') {
        updated = await api.approveLoopItemRun(projectId, issueId, current.task.version)
      } else {
        updated = await api.rejectLoopItemRun(projectId, issueId, current.task.version, reason)
      }
      if (isCurrent()) input?.onTaskUpdated?.(updated)
    } catch (cause) {
      if (isCurrent())
        reportError(
          cause instanceof Error
            ? cause.message
            : current.t(
                action === 'accept'
                  ? 'workbench.task_activity_accept_failed'
                  : action === 'approve'
                    ? 'workbench.task_activity_approve_failed'
                    : 'workbench.task_activity_reject_failed'
              )
        )
    }
  }
  return {
    getSnapshot: () => snapshot,
    beginSend() {
      const operation = {}
      pendingSends.add(operation)
      publish({ sending: true })
      return () => {
        pendingSends.delete(operation)
        publish({ sending: pendingSends.size > 0 })
      }
    },
    subscribe(listener: () => void, next: TaskActivityInput) {
      observers.set(listener, next)
      input = next
      lifecycleTrace.update({
        taskId: issueId,
        projectId,
        ...next.lifecycleTrace,
        clientReady: Boolean(client),
        executionSupport: Boolean(client?.executeTaskComment),
      })
      start()
      subscribeFeed()
      locateNotification()
      refreshExecutionFacts()
      return () => {
        observers.delete(listener)
        input = [...observers.values()].at(-1) ?? input
        queueMicrotask(() => {
          if (active()) return
          lifecycleTrace.dispose()
          generation++
          feedGeneration++
          unsubscribeFeed?.()
          unsubscribeFeed = undefined
          feedVersion = null
          started = false
          notificationKey = undefined
        })
      }
    },
    captureScope() {
      const epoch = generation
      return () => active() && generation === epoch
    },
    acceptTask: () => changeTask('accept'),
    approveTaskRun: () => changeTask('approve'),
    rejectTaskRun: (reason?: string) => changeTask('reject', reason),
    receiveMessages,
    reportError,
    taskUpdated(updated: CloudLoopItem) {
      if (active()) input?.onTaskUpdated?.(updated)
    },
    async markRead(sequence: number) {
      if (!api) return
      if (!active() || !input) throw new DOMException('Activity read scope changed', 'AbortError')
      const epoch = generation
      const revision = input.task.content_revision
      try {
        const updated = await api.markLoopItemRead(issueId, sequence, revision)
        if (!active() || generation !== epoch)
          throw new DOMException('Activity read scope changed', 'AbortError')
        publish({ readError: null })
        input?.onTaskRead?.(updated)
      } catch (cause) {
        if (active() && generation === epoch)
          publish({
            readError:
              cause instanceof Error ? cause.message : (input?.t('workbench.save_failed') ?? ''),
          })
        throw cause
      }
    },
  }
}
