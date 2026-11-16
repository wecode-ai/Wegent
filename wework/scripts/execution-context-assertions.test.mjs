import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { withExecutionContextAssertions } from '../e2e/desktop/modules/execution-context-assertions.mjs'
import { readRequestBody } from '../e2e/desktop/modules/response-protocol.mjs'

const body = context => ({ input: [{ role: 'user', content: `WORK ${context}` }] })
const request = value => Object.assign(Readable.from([JSON.stringify(value)]), { method: 'POST' })
const url = new URL('http://localhost/responses')

test('native approval review quotes worker input without becoming a worker execution', async () => {
  let reviewed = false
  const scenario = withExecutionContextAssertions(
    {
      async handleHttp() {
        reviewed = true
        return true
      },
      async verify() {},
    },
    { marker: 'WORK', expected: ['already started'] }
  )
  const value = {
    ...body('quoted action under native approval review'),
    text: {
      format: {
        schema: {
          properties: {
            risk_level: { type: 'string' },
            user_authorization: { type: 'string' },
            rationale: { type: 'string' },
            outcome: { enum: ['allow', 'deny'] },
          },
        },
      },
    },
  }
  assert.equal(await scenario.handleHttp(request(value), {}, url), true)
  assert.equal(reviewed, true)
  await assert.rejects(scenario.verify({}), /real worker/)
})

test('execution assertions inspect the same cached body as the existing model scenario', async () => {
  const value = body('already started; native permissions')
  const scenario = withExecutionContextAssertions(
    {
      async handleHttp(req) {
        assert.deepEqual(await readRequestBody(req), value)
        return true
      },
      async verify() {},
    },
    { marker: 'WORK', expected: ['already started'] }
  )
  assert.equal(await scenario.handleHttp(request(value), {}, url), true)
  await scenario.verify({})
})

test('missing execution facts fail instead of accepting a successful worker response', async () => {
  const scenario = withExecutionContextAssertions(
    {
      async handleHttp() {
        return true
      },
    },
    {
      marker: 'WORK',
      expected: ['already started'],
    }
  )
  await assert.rejects(
    scenario.handleHttp(request(body('native permissions')), {}, url),
    /Missing execution fact/
  )
})

test('primary requests cannot satisfy the scheduled-worker observation', async () => {
  const scenario = withExecutionContextAssertions(
    {
      async handleHttp() {
        return true
      },
      async verify() {},
    },
    { marker: 'WORK', workerContext: 'read window', expected: ['already started'] }
  )
  await scenario.handleHttp(request(body('create a future review')), {}, url)
  await assert.rejects(scenario.verify({}), /real worker/)
})

for (const metadata of [
  { request_kind: 'compaction' },
  { request_kind: 'prewarm' },
  { thread_source: 'composer_predictions' },
]) {
  test(`maintenance is delegated without counting quoted worker text: ${JSON.stringify(metadata)}`, async () => {
    let delegated = false
    const scenario = withExecutionContextAssertions(
      {
        async handleHttp() {
          delegated = true
          return true
        },
        async verify() {},
      },
      { marker: 'WORK', expected: ['already started'] }
    )
    const value = {
      ...body('quoted business context, not an execution'),
      client_metadata: { 'x-codex-turn-metadata': JSON.stringify(metadata) },
    }
    assert.equal(await scenario.handleHttp(request(value), {}, url), true)
    assert.equal(delegated, true)
    await assert.rejects(scenario.verify({}), /real worker/)
  })
}
