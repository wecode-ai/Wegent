import assert from 'node:assert/strict'
import test from 'node:test'
import { ExecutorSessionProjectionStream } from './session-projection-stream.js'

test('resumes projection after the latest accepted executor sequence', async () => {
  const cursors = []
  const handled = []
  let connection = 0
  const stream = new ExecutorSessionProjectionStream(
    { handle: event => handled.push(event.sequence) },
    {
      createEventStream(options) {
        cursors.push(options.afterSequence)
        connection += 1
        return {
          async start() {
            options.onEvent({ sequence: connection })
            if (connection === 1) options.onClose()
          },
          stop() {},
        }
      },
    }
  )

  stream.start()
  await waitFor(() => cursors.length === 2)
  stream.stop()

  assert.deepEqual(cursors, [0, 1])
  assert.deepEqual(handled, [1, 2])
})

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for projection reconnect')
}
