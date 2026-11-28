import {
  acceptsProjectChatMessage,
  type ProjectChatClient,
  type ProjectChatMessage,
} from '@wegent/chat-core'

export function mergeIssueChatMessages(
  current: ProjectChatMessage[],
  incoming: ProjectChatMessage[]
) {
  const byId = new Map(current.map(message => [message.messageId, message]))
  for (const message of incoming) {
    const previous = byId.get(message.messageId)
    // Runtime sequence distinguishes updates within the same SQL timestamp.
    if (!previous || acceptsProjectChatMessage(previous, message)) {
      if (previous?.metadata.workflow_task_title && !message.metadata.workflow_task_title) {
        console.debug('[Issue activity] Workflow title removed', JSON.stringify({
          messageId: message.messageId,
          previousTrace: previous.traceState,
          nextTrace: message.traceState,
          sameSource: previous.traceRef === message.traceRef,
          sequence: message.metadata.runtime_event_sequence,
          type: message.type,
        }))
      }
      byId.set(message.messageId, message)
    }
  }
  return [...byId.values()].sort((a, b) => a.sequenceNumber - b.sequenceNumber)
}

/** One client/project/Issue owns its canonical messages and reconnect session. */
export function createIssueProjectChatSource(
  client: ProjectChatClient | undefined,
  projectId: string,
  issueId: string
) {
  const owner = { client, projectId, issueId }
  const empty = {
    owner,
    messages: [] as ProjectChatMessage[],
    loading: Boolean(client),
    ready: false,
    currentUserId: undefined as string | undefined,
    error: null as string | null,
  }
  let snapshot = empty
  let authorityEpoch = 0
  let revoked = false
  let activeRevision: number | undefined
  let invalidatesSnapshot: ((cause: unknown) => boolean) | undefined
  let connection: { detach(): (() => void) | undefined } | undefined
  const listeners = new Set<() => void>()
  const statusListeners = new Set<() => void>()
  const statusOf = ({ owner, loading, ready, currentUserId, error }: typeof snapshot) => ({
    owner,
    loading,
    ready,
    currentUserId,
    error,
  })
  let status = statusOf(snapshot)
  const publish = (next: typeof snapshot) => {
    snapshot = next
    const nextStatus = statusOf(next)
    const statusChanged =
      nextStatus.loading !== status.loading ||
      nextStatus.ready !== status.ready ||
      nextStatus.currentUserId !== status.currentUserId ||
      nextStatus.error !== status.error
    if (statusChanged) status = nextStatus
    listeners.forEach(listener => listener())
    if (statusChanged) statusListeners.forEach(listener => listener())
  }
  const merge = (incoming: ProjectChatMessage[]) => {
    if (listeners.size && !revoked)
      publish({
        ...snapshot,
        messages: mergeIssueChatMessages(snapshot.messages, incoming),
      })
  }
  const connect = (retained?: () => void) => {
    if (!client) return
    const releaseRetained = () => {
      retained?.()
      retained = undefined
    }
    let active = true
    let unsubscribe: (() => void) | undefined
    let subscribing = false
    let reconnectDuringAttempt = false
    const current = () => active && listeners.size > 0
    const subscribe = () => {
      if (!current() || subscribing || unsubscribe) return
      subscribing = true
      reconnectDuringAttempt = false
      const epoch = authorityEpoch
      let valid = true
      let authorized = false
      const buffered: Array<(messages: ProjectChatMessage[]) => ProjectChatMessage[]> = []
      const accepts = () => valid && current() && epoch === authorityEpoch
      const receive = (message: ProjectChatMessage) => {
        if (!accepts()) return
        if (!authorized) buffered.push(messages => mergeIssueChatMessages(messages, [message]))
        else merge([message])
      }
      void Promise.resolve()
        .then(() => {
          if (!current()) return undefined
          return client.subscribe(projectId, issueId, 0, receive, chunk => {
            if (!accepts()) return
            const apply = (messages: ProjectChatMessage[]) => {
              const message = messages.find(message => message.messageId === chunk.messageId)
              if (
                message &&
                !acceptsProjectChatMessage(
                  message,
                  chunk,
                  chunk.metadata.contentMode !== 'snapshot'
                )
              )
                return messages
              return mergeIssueChatMessages(messages, [
                {
                  ...chunk,
                  content:
                    chunk.metadata.contentMode === 'snapshot'
                      ? chunk.content
                      : `${message?.content ?? ''}${chunk.content}`,
                },
              ])
            }
            if (!authorized) buffered.push(apply)
            else {
              const messages = apply(snapshot.messages)
              if (messages !== snapshot.messages) publish({ ...snapshot, messages })
            }
          })
        })
        .then(subscription => {
          if (!subscription) return
          if (!accepts()) {
            subscription.unsubscribe()
            return
          }
          unsubscribe = subscription.unsubscribe
          releaseRetained()
          // Preserve pre-snapshot event order, including sequence-less deltas.
          const messages = buffered.reduce((items, apply) => apply(items), snapshot.messages)
          buffered.length = 0
          revoked = false
          authorized = true
          publish({
            ...snapshot,
            loading: false,
            ready: true,
            error: null,
            currentUserId: subscription.snapshot.currentUserId,
            messages: mergeIssueChatMessages(messages, subscription.snapshot.messages),
          })
        })
        .catch(cause => {
          valid = false
          buffered.length = 0
          if (!current()) return
          releaseRetained()
          const invalidated = invalidatesSnapshot?.(cause)
          if (invalidated) {
            authorityEpoch += 1
            revoked = true
          }
          publish({
            ...(invalidated ? empty : snapshot),
            loading: false,
            error: cause instanceof Error ? cause.message : String(cause),
          })
        })
        .finally(() => {
          subscribing = false
          if (current() && reconnectDuringAttempt && !unsubscribe) subscribe()
        })
    }
    const stopReconnect = client.onReconnect?.(() => {
      if (!current()) return
      if (subscribing) reconnectDuringAttempt = true
      else subscribe()
    })
    subscribe()
    return {
      detach() {
        active = false
        stopReconnect?.()
        const release = unsubscribe ?? retained
        unsubscribe = undefined
        retained = undefined
        return release
      },
    }
  }
  return {
    getSnapshot: () => snapshot,
    captureSendReceipt: () => (listeners.size && !revoked ? authorityEpoch : null),
    mergeSendReceipt(epoch: number | null, incoming: ProjectChatMessage[]) {
      if (epoch !== null && epoch === authorityEpoch) merge(incoming)
    },
    merge,
    getStatusSnapshot: () => status,
    subscribe(listener: () => void) {
      listeners.add(listener)
      queueMicrotask(() => {
        if (listeners.size && !connection) connection = connect()
      })
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        connection?.detach()?.()
        connection = undefined
      }
    },
    observeStatus(
      listener: () => void,
      revision: number,
      invalidate?: (cause: unknown) => boolean
    ) {
      statusListeners.add(listener)
      invalidatesSnapshot = invalidate
      if (activeRevision !== revision) {
        activeRevision = revision
        if (connection) {
          // Keep the room lease through the same-Issue refresh. The new read
          // occurs before the server joins the room, so releasing first can
          // lose a live reply between the snapshot and the new join.
          connection = connect(connection.detach())
        }
      }
      return () => {
        statusListeners.delete(listener)
      }
    },
  }
}
