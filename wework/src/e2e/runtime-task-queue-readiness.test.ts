// @vitest-environment node

import assert from 'node:assert/strict'
import { test } from 'vitest'

import { assertQueuePosition } from '../../e2e/desktop/scenarios/runtime-task-queue.scenario.mjs'
import { createBarrier } from '../test/async-barrier'

const SELECTOR = '[data-testid="runtime-local-task-queue-position-queued-task"]'

test('queue position waits for metadata and reads it before the next sidebar refresh', async () => {
  const waiting = createBarrier()
  const metadataReady = createBarrier()
  let text = ''
  const verification = assertQueuePosition(
    {
      async command(action: string, selector: string, options: { text?: string }) {
        assert.equal(selector, SELECTOR)
        if (action === 'waitFor') {
          waiting.release()
          if (options.text && !text.includes(options.text)) await metadataReady.promise
          const observed = text
          // The next render can invalidate a successful observation between commands.
          text = ''
          return observed
        }
        assert.equal(action, 'getText')
        return text
      },
    },
    SELECTOR,
    '2',
    true
  ).then(
    () => null,
    (error: unknown) => error
  )
  await waiting.promise
  text = '2'
  metadataReady.release()
  assert.equal(await verification, null)
})

test.each([true, false])('queue position preserves visibility selection (%s)', async visible => {
  await assertQueuePosition(
    {
      async command(
        action: string,
        selector: string,
        options: { text?: string; visible?: boolean }
      ) {
        assert.equal(action, 'waitFor')
        assert.equal(selector, SELECTOR)
        assert.deepEqual(options, { ...(visible ? { visible: true } : {}), text: '2' })
        return '1\n2'
      },
    },
    SELECTOR,
    '2',
    visible
  )
})

test.each(['', '12'])(
  'queue position still rejects missing or inexact positions (%j)',
  async text => {
    await assert.rejects(
      assertQueuePosition({ command: async () => text }, SELECTOR, '2', true),
      /No queue position found|Expected a queue position of 2/
    )
  }
)

test('queue position propagates a readiness timeout', async () => {
  const failure = new Error('Timed out waiting for queue position 2')
  await assert.rejects(
    assertQueuePosition(
      {
        async command() {
          throw failure
        },
      },
      SELECTOR,
      '2',
      true
    ),
    error => error === failure
  )
})
