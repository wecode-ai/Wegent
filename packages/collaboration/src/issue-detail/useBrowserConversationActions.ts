import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  RequestUserInputPayload,
  RequestUserInputResponse,
  RuntimeTaskAddress,
} from '@wegent/chat-core/runtime'
import {
  requestUserInputPayloadKey,
  requestUserInputResponseText,
} from '@wegent/chat-core/runtime-user-input'
import type { createRuntimeConversationSession } from '@wegent/chat-core/runtime-conversation-session'
import type { SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationTranslate } from '../i18n'
import type { RuntimeSendRequest } from '@wegent/chat-core/runtime-task-api-types'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import { retryRuntimeConversation } from '../execution/retryRuntimeConversation'

type Session = ReturnType<typeof createRuntimeConversationSession>
type QuestionRuntime = Pick<SharedWorkspaceRuntimeApi, 'cancel'> & {
  work: Pick<SharedWorkspaceRuntimeApi['work'], 'sendRuntimeMessage'>
}

/** Bind the PC question cards to the addressed runtime; rejected answers remain editable. */
export function useBrowserConversationActions(
  runtime: QuestionRuntime,
  address: RuntimeTaskAddress,
  session: Session,
  translate: CollaborationTranslate,
  retryRequest?: () => Omit<RuntimeSendRequest, 'message' | 'clientUserMessageId'>
) {
  const pending = useRef(new Set<Session>())
  const owner = useRef<Session | null>(session)
  useLayoutEffect(() => {
    owner.current = session
    return () => {
      owner.current = null
    }
  }, [session])
  const emptyHidden = useMemo(() => new Set<string>(), [])
  const [result, setResult] = useState<{
    owner: Session
    error: string | null
    hidden: Set<string>
  } | null>(null)
  const current = result?.owner === session ? result : null
  function setError(error: string | null) {
    if (owner.current !== session) return
    setResult(previous => ({
      owner: session,
      error,
      hidden: previous?.owner === session ? previous.hidden : new Set(),
    }))
  }
  return {
    error: current?.error ?? null,
    hiddenRequestUserInputIds: current?.hidden ?? emptyHidden,
    onRetryFailedMessage: retryRequest
      ? async (message: WorkbenchMessage): Promise<boolean> => {
          if (pending.current.has(session)) return false
          pending.current.add(session)
          setError(null)
          try {
            await retryRuntimeConversation({
              messageId: message.id,
              messages: session.getSnapshot().messages,
              request: retryRequest(),
              labels: {
                continue: translate('workbench.retry_continue_message'),
                missing: translate('workbench.retry_message_missing'),
                failed: translate('workbench.retry_failed'),
              },
              addUserMessage: session.addUserMessage,
              removeUserMessage: session.removeUserMessage,
              async send(request) {
                const result = await runtime.work.sendRuntimeMessage(request)
                if (!result.accepted)
                  throw new Error(result.error || translate('workbench.retry_failed'))
                return true
              },
            })
            return true
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
            return false
          } finally {
            pending.current.delete(session)
          }
        }
      : undefined,
    async onRequestUserInputSubmit(response: RequestUserInputResponse): Promise<boolean> {
      if (pending.current.has(session)) return false
      pending.current.add(session)
      setError(null)
      try {
        const accepted = await runtime.work.sendRuntimeMessage({
          address,
          message: requestUserInputResponseText(response),
          requestUserInputResponse: response,
        })
        if (!accepted.accepted) throw new Error(accepted.error || translate('todo.send_failed'))
        session.applyUserInputResponse(response)
        return true
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
        return false
      } finally {
        pending.current.delete(session)
      }
    },
    async onRequestUserInputIgnore(payload: RequestUserInputPayload): Promise<void> {
      if (pending.current.has(session)) return
      pending.current.add(session)
      setError(null)
      try {
        await runtime.cancel(address)
        const key = requestUserInputPayloadKey(payload)
        if (key && owner.current === session)
          setResult(previous => ({
            owner: session,
            error: null,
            hidden: new Set([...(previous?.owner === session ? previous.hidden : []), key]),
          }))
        await session.reload()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        pending.current.delete(session)
      }
    },
  }
}
