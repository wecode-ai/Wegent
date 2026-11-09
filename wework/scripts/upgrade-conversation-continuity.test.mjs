import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createUpgradeConversationContinuity } from '../e2e/desktop/modules/upgrade-conversation-continuity.mjs'

test('upgrade inference must retain both sides of every completed native turn', async () => {
  const continuity = createUpgradeConversationContinuity(
    () => ({ command: async () => undefined }),
    10_000
  )
  await continuity.send('source user', 'source assistant')
  assert.throws(() => continuity.observeModel({ input: ['source user'] }), /assistant output/)
  assert.throws(() => continuity.observeModel({ input: ['source assistant'] }), /user input/)
  continuity.observeModel({ input: ['source user', 'source assistant', 'upgraded user'] })
  await continuity.send('upgraded user', 'upgraded assistant')
  assert.throws(
    () => continuity.observeModel({ input: ['source user', 'source assistant'] }),
    /user input/
  )
  continuity.observeModel({
    input: ['source user', 'source assistant', 'upgraded user', 'upgraded assistant'],
  })
})

test('a failed send does not fabricate a completed history prerequisite', async () => {
  const continuity = createUpgradeConversationContinuity(
    () => ({
      command: async () => {
        throw new Error('not sent')
      },
    }),
    10_000
  )
  await assert.rejects(continuity.send('not sent user', 'not sent answer'), /not sent/)
  continuity.observeModel({ input: ['a different first request'] })
})
