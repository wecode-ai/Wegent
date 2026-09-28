import { useEffect, useMemo, type ReactNode } from 'react'
import type { RuntimeConversationClient } from '@wegent/chat-core'
import { createScope, RuntimeConversationScopeContext } from './runtimeConversationScopeContext'

/** Retain visited executions until the Issue closes; unopened activity performs no I/O. */
export function RuntimeConversationScope({
  runtime,
  children,
}: {
  runtime: RuntimeConversationClient
  children: ReactNode
}) {
  const scope = useMemo(() => createScope(runtime), [runtime])
  useEffect(() => {
    scope.start()
    return scope.stop
  }, [scope])
  return (
    <RuntimeConversationScopeContext.Provider value={scope}>
      {children}
    </RuntimeConversationScopeContext.Provider>
  )
}
