import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createBarrier as barrier } from '../test/async-barrier'
import { verifyCachedInitialRecovery } from '../../e2e/desktop/modules/issue-transcript-transfer.mjs'

test('cached Issue history settles its current read before injecting a new initial-read failure', async () => {
  const waiting = barrier()
  const settled = barrier()
  const reachedClose = new Error('The initial read has settled')
  const originalRule = () => null
  const proxy = { requests: [], rule: originalRule }
  let ready = false
  const recovery = verifyCachedInitialRecovery({
    control: {
      async command(action: string, selector: string) {
        if (action === 'waitFor' && selector.includes('[aria-busy="false"]')) {
          assert.match(selector, /work-item-task-chat-panel/)
          waiting.release()
          await settled.promise
          ready = true
        }
        if (selector.includes('ai-chat-modal-close')) {
          assert.equal(ready, true, 'Cached text does not prove that the shared read is finished')
          throw reachedClose
        }
      },
    },
    proxy,
    scope: (selector: string) => selector,
    binding: { id: 'bound-task' },
  }).then(
    () => new Error('Expected the close boundary'),
    (error: unknown) => error
  )
  assert.equal(await Promise.race([waiting.promise.then(() => 'waiting'), recovery]), 'waiting')
  assert.equal(proxy.rule, originalRule)
  settled.release()
  assert.equal(await recovery, reachedClose)
})
