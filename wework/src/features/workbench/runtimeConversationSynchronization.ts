import type {
  RuntimeTaskAddress,
  RuntimeTranscriptRequest,
  RuntimeTranscriptResponse,
} from '@/types/api'
import { projectRuntimePaneTranscript } from '@wegent/chat-core/runtime-transcript-page'
import type { RuntimePaneTranscript } from '@/types/workbench'
import {
  abortRuntimeConversationHydration,
  adoptRuntimeConversationThread,
  beginRuntimeConversationHydration,
  beginRuntimeConversationOperation,
  completeRuntimeConversationHydration,
  runtimeConversationKey,
} from './runtimeConversationCache'

type Reader = (request: RuntimeTranscriptRequest) => Promise<RuntimeTranscriptResponse>
interface Writer {
  threadId?: string | null
  generation: number
  pending?: Promise<RuntimePaneTranscript>
}
const requests = new Map<string, Promise<RuntimePaneTranscript>>()
const conversations = new Map<string, Writer>()
export class SupersededConversationRead extends Error {}

/** All viewers and recovery triggers share one serial snapshot writer per conversation. */
export function synchronizeRuntimeConversation(
  read: Reader,
  address: RuntimeTaskAddress,
  options: Omit<RuntimeTranscriptRequest, keyof RuntimeTaskAddress> = {}
): Promise<RuntimePaneTranscript> {
  const conversationKey = runtimeConversationKey(address)
  const writer: Writer = conversations.get(conversationKey) ?? { generation: 0 }
  if (address.threadId && writer.threadId && address.threadId !== writer.threadId)
    writer.generation += 1
  if (address.threadId) writer.threadId = address.threadId
  conversations.set(conversationKey, writer)
  const generation = writer.generation
  const requestKey = JSON.stringify([
    conversationKey,
    writer.threadId,
    generation,
    options.limit ?? null,
    options.refresh ?? false,
    options.beforeCursor ?? null,
    options.afterCursor ?? null,
    options.includeFullContent ?? false,
    options.conversationContextOnly ?? false,
    options.navigationOnly ?? false,
  ])
  const existing = requests.get(requestKey)
  if (existing) return existing
  const previous = writer.pending
  const operation = beginRuntimeConversationOperation(address)
  const pending = (async () => {
    await Promise.resolve()
    if (previous) await previous.catch(() => undefined)
    if (writer.generation !== generation) throw new SupersededConversationRead()
    if (!options.navigationOnly) adoptRuntimeConversationThread(address, address.threadId)
    const token = options.navigationOnly ? null : beginRuntimeConversationHydration(address)
    try {
      const response = await read({ ...address, ...options })
      if (writer.generation !== generation) throw new SupersededConversationRead()
      if (!Array.isArray(response.turns))
        throw new Error('Runtime transcript response is missing canonical turns')
      const transcript = projectRuntimePaneTranscript(response)
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
      if (token) abortRuntimeConversationHydration(address, token)
      throw error
    }
  })().finally(() => {
    operation.dispose()
    if (requests.get(requestKey) === pending) requests.delete(requestKey)
    if (writer.pending === pending) conversations.delete(conversationKey)
  })
  requests.set(requestKey, pending)
  writer.pending = pending
  return pending
}

/** Viewing a child thread does not adopt it as the task's current conversation. */
export async function readRuntimeThreadConversation(
  read: Reader,
  address: RuntimeTaskAddress,
  options: Omit<RuntimeTranscriptRequest, keyof RuntimeTaskAddress> = {}
): Promise<RuntimePaneTranscript> {
  if (!address.threadId) throw new Error('A thread view requires an explicit thread identity')
  const response = await read({ ...address, ...options })
  if (response.threadId !== address.threadId)
    throw new Error('Runtime returned a different thread for the requested view')
  return projectRuntimePaneTranscript(response)
}
