import { useMemo } from 'react'
import type { RequestUserInputPayload, RequestUserInputResponse } from '@wegent/chat-core/runtime'
import type { RuntimeTaskAddress } from '@/types/api'
import { useRuntimeInteractions } from './RuntimeInteractionsContext'
import { canQuickReply, canReplyToInteraction, interactionId } from './runtimeInteractions'
import {
  requestUserInputPayloadKey,
  requestUserInputResponseKey,
} from '@/components/chat/requestUserInputMessages'

interface RuntimeUserInputHost {
  getError(payload: RequestUserInputPayload): string | undefined
  isDisabled(payload: RequestUserInputPayload): boolean
  isSubmitting(payload: RequestUserInputPayload): boolean
  getDraft(payload: RequestUserInputPayload): Record<string, string> | undefined
  setDraft(payload: RequestUserInputPayload, answers: Record<string, string>): void
  submit(
    response: RequestUserInputResponse,
    payload?: RequestUserInputPayload | null
  ): Promise<boolean | undefined>
}

/** Reuse existing reply coordination without rebuilding the entity's input controls. */
export function useRuntimeInteractionInputHost(
  address: RuntimeTaskAddress | null,
  enabled: boolean
) {
  const interactions = useRuntimeInteractions()
  return useMemo<RuntimeUserInputHost | undefined>(() => {
    if (!enabled || !interactions || !address) return undefined
    const pending = (key: string | null) =>
      interactions.pending.find(item => item.id === interactionId({ address }, key ?? ''))
    const question = (payload: RequestUserInputPayload) =>
      pending(requestUserInputPayloadKey(payload))
    const isSubmitting = (payload: RequestUserInputPayload) => {
      const item = question(payload)
      return Boolean(item && interactions.busy.has(item.id))
    }
    return {
      getError(payload) {
        const item = question(payload)
        return item ? interactions.errors[item.id] : undefined
      },
      isSubmitting,
      isDisabled(payload) {
        const item = question(payload)
        return (
          isSubmitting(payload) ||
          (canQuickReply(payload) && (!item || !canReplyToInteraction(item)))
        )
      },
      getDraft(payload) {
        if (!canQuickReply(payload)) return undefined
        const item = question(payload)
        const draft = item && interactions.drafts[item.id]
        return item && draft !== undefined ? { [payload.questions![0].id!]: draft } : undefined
      },
      setDraft(payload, answers) {
        if (!canQuickReply(payload)) return
        const item = question(payload)
        if (item) interactions.setDraft(item.id, answers[payload.questions![0].id!] ?? '')
      },
      async submit(response, payload) {
        const key = requestUserInputResponseKey(response)
        if (interactions.history.some(item => item.id === interactionId({ address }, key ?? '')))
          return false
        const item = pending(key)
        if (!item || !canReplyToInteraction(item))
          return payload && canQuickReply(payload) ? false : undefined
        const answers = response.answers[item.payload.questions![0].id!]?.answers
        if (answers?.length !== 1) return undefined
        return interactions.respond(item, answers[0])
      },
    }
  }, [address, enabled, interactions])
}
