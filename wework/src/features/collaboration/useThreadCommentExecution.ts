import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ProjectChatClient, ProjectChatMessage } from '@wegent/chat-core'
import type { ChatGroupApi } from '@/api/chatGroups'
import type { ThreadActionContext } from './threadActions'
import { executeThreadComment } from './threadCommentExecution'

export function useThreadCommentExecution({
  context,
  groups,
  chat,
  active,
  unavailable,
  onMessages,
}: {
  context: ThreadActionContext | null
  groups: ChatGroupApi
  chat?: ProjectChatClient
  active: boolean
  unavailable: string
  onMessages(messages: ProjectChatMessage[]): void
}) {
  const api = context?.api
  const owner = context
    ? JSON.stringify([
        context.accountScope,
        context.sourceStore,
        context.group.id,
        context.item.id,
        context.participation?.current_user_id,
      ])
    : ''
  const scope = useMemo(
    () => ({ api, owner, groups, chat, active }),
    [api, owner, groups, chat, active]
  )
  const current = useRef<object | null>(scope)
  const request = useRef<Promise<boolean> | null>(null)
  const [state, setState] = useState<{
    scope: object
    busy: boolean
    failure: { trigger: ProjectChatMessage; error: string } | null
  } | null>(null)
  useLayoutEffect(() => {
    current.current = scope
    return () => {
      current.current = null
      request.current = null
    }
  }, [scope])
  const execute = (trigger: ProjectChatMessage): Promise<boolean> => {
    if (!context || !chat || !active) return Promise.resolve(false)
    const previous = request.current
    const pending = (async () => {
      if (previous) await previous
      if (current.current !== scope) return false
      setState({ scope, busy: true, failure: null })
      try {
        const incoming = await executeThreadComment({
          context,
          groups,
          chat,
          trigger,
          unavailable,
          isCurrent: () => current.current === scope,
        })
        if (current.current !== scope) return false
        onMessages(incoming)
        setState({ scope, busy: false, failure: null })
        return true
      } catch (cause) {
        if (current.current === scope)
          setState({
            scope,
            busy: false,
            failure: { trigger, error: cause instanceof Error ? cause.message : String(cause) },
          })
        return false
      }
    })()
    request.current = pending
    void pending.finally(() => {
      if (request.current === pending) request.current = null
    })
    return pending
  }
  const failure = state?.scope === scope ? state.failure : null
  return {
    execute,
    error: failure?.error ?? null,
    busy: state?.scope === scope && state.busy,
    retry: () => (failure ? execute(failure.trigger) : Promise.resolve(false)),
  }
}
