import type {
  RuntimeTaskAddress,
  RuntimeTranscriptRequest,
  RuntimeTranscriptResponse,
} from '@/types/api'
import { projectRuntimePaneTranscript } from '@wegent/chat-core/runtime-transcript-page'
import type { RuntimePaneTranscript } from '@/types/workbench'
import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'
import {
  abortableRuntimeRead,
  cancelledRuntimeRead,
  subscribeRuntimeRead,
  type RuntimeReadOptions,
  type SharedRuntimeRead,
} from './runtimeConversationReadCancellation'
import {
  abortRuntimeConversationHydration,
  adoptRuntimeConversationThread,
  beginRuntimeConversationHydration,
  beginRuntimeConversationOperation,
  completeRuntimeConversationHydration,
  runtimeConversationKey,
} from './runtimeConversationCache'

type Reader = (
  request: RuntimeTranscriptRequest,
  options?: RuntimeReadOptions
) => Promise<RuntimeTranscriptResponse>
type ReadOptions = Omit<RuntimeTranscriptRequest, keyof RuntimeTaskAddress>
type SynchronizationOptions = ReadOptions & RuntimeReadOptions & { isolated?: boolean }
interface Writer {
  threadId?: string | null
  generation: number
  pending?: Promise<void>
  controllers: Set<AbortController>
}
const requests = new Map<string, SharedRuntimeRead<RuntimePaneTranscript>>()
const conversations = new Map<string, Writer>()
export class SupersededConversationRead extends Error {}

/** Canonical page projection is shared by snapshot writers and isolated viewers. */
async function readRuntimeConversation(
  read: Reader,
  address: RuntimeTaskAddress,
  options: ReadOptions,
  signal?: AbortSignal
): Promise<RuntimePaneTranscript> {
  if (signal?.aborted) throw cancelledRuntimeRead()
  const response = await (signal
    ? abortableRuntimeRead(read({ ...address, ...options }, { signal }), signal)
    : read({ ...address, ...options }))
  if (signal?.aborted) throw cancelledRuntimeRead()
  if (!Array.isArray(response.turns))
    throw new Error('Runtime transcript response is missing canonical turns')
  return projectRuntimePaneTranscript(response)
}

/** All viewers and recovery triggers share one serial snapshot writer per conversation. */
export function synchronizeRuntimeConversation(
  read: Reader,
  address: RuntimeTaskAddress,
  { isolated, signal, ...options }: SynchronizationOptions = {}
): Promise<RuntimePaneTranscript> {
  if (signal?.aborted) return Promise.reject(cancelledRuntimeRead())
  if (isolated) return readRuntimeConversation(read, address, options, signal)
  const conversationKey = runtimeConversationKey(address)
  const writer: Writer = conversations.get(conversationKey) ?? {
    generation: 0,
    controllers: new Set(),
  }
  if (address.threadId && writer.threadId && address.threadId !== writer.threadId) {
    writer.generation += 1
    for (const controller of writer.controllers) controller.abort()
    writer.pending = undefined
  }
  if (address.threadId) writer.threadId = address.threadId
  conversations.set(conversationKey, writer)
  const generation = writer.generation
  const requestKey = JSON.stringify([
    conversationKey,
    writer.threadId,
    generation,
    address.projectSession?.projectId ?? null,
    address.projectSession?.issueId ?? null,
    options.limit ?? null,
    options.refresh ?? false,
    options.beforeCursor ?? null,
    options.afterCursor ?? null,
    options.includeFullContent ?? false,
    options.conversationContextOnly ?? false,
    options.navigationOnly ?? false,
    options.reconcileClientUserMessageIds?.slice().sort() ?? null,
  ])
  const existing = requests.get(requestKey)
  if (existing && !existing.controller.signal.aborted) {
    diagnoseRead('join', address, options)
    return subscribeRuntimeRead(existing, signal)
  }
  const controller = new AbortController()
  writer.controllers.add(controller)
  const previous = writer.pending
  const operation = beginRuntimeConversationOperation(address)
  const pending = (async () => {
    await Promise.resolve()
    if (previous)
      await abortableRuntimeRead(
        previous.catch(() => undefined),
        controller.signal
      )
    if (controller.signal.aborted) throw cancelledRuntimeRead()
    if (writer.generation !== generation) throw new SupersededConversationRead()
    if (!options.navigationOnly) adoptRuntimeConversationThread(address, address.threadId)
    const token = options.navigationOnly ? null : beginRuntimeConversationHydration(address)
    try {
      diagnoseRead('start', address, options)
      const transcript = await abortableRuntimeRead(
        readRuntimeConversation(read, address, options, controller.signal),
        controller.signal
      )
      diagnoseRead('resolved', address, options)
      if (writer.generation !== generation) throw new SupersededConversationRead()
      if (token && operation.isCurrent()) {
        completeRuntimeConversationHydration(
          address,
          token,
          transcript.turns,
          transcript.threadId,
          transcript.supersededTurnIds
        )
      } else if (token) {
        abortRuntimeConversationHydration(address, token)
      }
      return transcript
    } catch (error) {
      diagnoseRead('rejected', address, options)
      if (token) abortRuntimeConversationHydration(address, token)
      throw error
    }
  })()
    .catch(error => {
      if (writer.generation !== generation) throw new SupersededConversationRead()
      throw error
    })
    .finally(() => {
      operation.dispose()
      if (requests.get(requestKey)?.promise === pending) requests.delete(requestKey)
      writer.controllers.delete(controller)
    })
  // A cancelled queued subscriber must not let the next page bypass an active writer.
  const barrier = Promise.allSettled([previous, pending]).then(() => undefined)
  void barrier.then(() => {
    if (writer.pending === barrier) conversations.delete(conversationKey)
  })
  const shared = { promise: pending, controller, consumers: 0 }
  requests.set(requestKey, shared)
  writer.pending = barrier
  return subscribeRuntimeRead(shared, signal)
}

function diagnoseRead(action: string, address: RuntimeTaskAddress, options: ReadOptions): void {
  if (import.meta.env.VITE_WEWORK_E2E !== 'true') return
  logRuntimeTaskCreateStage('conversation-read', {
    action,
    taskId: address.taskId,
    projectSession: Boolean(address.projectSession),
    limit: options.limit ?? null,
    navigationOnly: options.navigationOnly === true,
  })
}

/** Viewing a child thread does not adopt it as the task's current conversation. */
export async function readRuntimeThreadConversation(
  read: Reader,
  address: RuntimeTaskAddress,
  { signal, ...options }: ReadOptions & RuntimeReadOptions = {}
): Promise<RuntimePaneTranscript> {
  if (!address.threadId) throw new Error('A thread view requires an explicit thread identity')
  const transcript = await readRuntimeConversation(read, address, options, signal)
  if (transcript.threadId !== address.threadId)
    throw new Error('Runtime returned a different thread for the requested view')
  return transcript
}
