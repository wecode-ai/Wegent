import { useMemo, type ReactNode } from 'react'
import type { RuntimeConversationClient } from '@wegent/chat-core'
import { createScope, RuntimeConversationScopeContext } from './runtimeConversationScopeContext'

/** Share visited execution facts within an Issue; unopened activity performs no I/O. */
export function RuntimeConversationScope({
  runtime,
  children,
}: {
  runtime: RuntimeConversationClient
  children: ReactNode
}) {
  const scope = useMemo(() => createScope(runtime), [runtime])
  return (
    <RuntimeConversationScopeContext.Provider value={scope}>
      {children}
    </RuntimeConversationScopeContext.Provider>
  )
}
