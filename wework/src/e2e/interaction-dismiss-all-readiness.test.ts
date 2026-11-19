// @vitest-environment node

import { expect, test, vi } from 'vitest'
import { verifyDismissAll } from '../../e2e/desktop/modules/human-interaction-dismiss-all.mjs'
import { createBarrier } from '../test/async-barrier'

vi.mock('../../e2e/desktop/modules/workspace-flows.mjs', () => ({
  reloadMainWindow: vi.fn(),
}))
vi.mock('../../e2e/desktop/modules/executor-rpc.mjs', () => ({
  requestExecutor: vi.fn(async () => ({ messages: [{ id: 'original', role: 'user' }] })),
}))

test('collapses the unanswered source question and waits for the ordinary composer before filling', async () => {
  const waitingForComposer = createBarrier()
  const composerReady = createBarrier()
  const command = vi.fn(async (action: string, selector: string) => {
    if (action === 'waitFor' && selector.includes('chat-message-input')) {
      waitingForComposer.release()
      await composerReady.promise
    }
    return ''
  })
  const verification = verifyDismissAll({ command }, 1000, 'task')
  await waitingForComposer.promise
  expect(
    command.mock.calls.some(
      ([action, selector]) =>
        action === 'click' && selector.includes('request-user-input-ignore-button')
    )
  ).toBe(true)
  expect(command.mock.calls.some(([action]) => action === 'fill')).toBe(false)
  composerReady.release()
  await verification
  expect(command.mock.calls.filter(([action]) => action === 'fill')).toHaveLength(1)
})
