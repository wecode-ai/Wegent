import { expect, test, vi } from 'vitest'
import { LOCAL_USER } from '@/api/local/localSession'
import { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle'
import { createWorkbenchSessionState } from './workbenchSessionState'

test('restores and persists the active blank chat scope', () => {
  const onStandaloneChatKeyChange = vi.fn()
  const session = createWorkbenchSessionState(
    LOCAL_USER,
    new RuntimeTaskLifecycleStore('standalone-chat-scope-test'),
    false,
    { initialStandaloneChatKey: 4, onStandaloneChatKeyChange }
  )

  expect(session.getSnapshot().state.standaloneChatKey).toBe(4)
  session.dispatch({ type: 'blank_chat_committed', standaloneChatKey: 4 })

  expect(session.getSnapshot().state.standaloneChatKey).toBe(5)
  expect(onStandaloneChatKeyChange).toHaveBeenCalledOnce()
  expect(onStandaloneChatKeyChange).toHaveBeenCalledWith(5)
})
