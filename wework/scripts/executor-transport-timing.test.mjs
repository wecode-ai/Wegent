import assert from 'node:assert/strict'
import test from 'node:test'
import { executorResourceTiming } from '../src/api/dsh/executorTransportTiming.ts'

function timing(requestId, overrides = {}) {
  return {
    name: 'http://127.0.0.1/private?token=must-not-be-logged',
    duration: 46_000,
    fetchStart: 100,
    domainLookupStart: 110,
    domainLookupEnd: 115,
    connectStart: 115,
    connectEnd: 125,
    requestStart: 45_100,
    responseStart: 45_120,
    responseEnd: 46_100,
    serverTiming: [{ name: 'wework-rpc', description: encodeURIComponent(requestId) }],
    ...overrides,
  }
}

test('correlates concurrent RPC timing by request id without exposing resource URLs', () => {
  const result = executorResourceTiming(
    [timing('other-request', { requestStart: 200 }), timing('requested-rpc')],
    'requested-rpc'
  )
  assert.deepEqual(result, {
    durationMs: 46_000,
    beforeRequestMs: 45_000,
    dnsMs: 5,
    connectMs: 10,
    responseWaitMs: 20,
    responseReadMs: 980,
  })
  assert.ok(!JSON.stringify(result).includes('must-not-be-logged'))
})

test('does not attribute another request or missing browser timing to a slow RPC', () => {
  assert.equal(executorResourceTiming([], 'missing'), null)
  assert.equal(executorResourceTiming([timing('other')], 'missing'), null)
  assert.equal(
    executorResourceTiming([timing('missing', { serverTiming: undefined })], 'missing'),
    null
  )
})

test('leaves unavailable or invalid network phases unknown', () => {
  assert.deepEqual(
    executorResourceTiming(
      [timing('redacted', { requestStart: 0, connectEnd: 0, domainLookupEnd: NaN })],
      'redacted'
    ),
    {
      durationMs: 46_000,
      beforeRequestMs: null,
      dnsMs: null,
      connectMs: null,
      responseWaitMs: null,
      responseReadMs: 980,
    }
  )
})

test('correlates encoded server timing identifiers', () => {
  assert.ok(executorResourceTiming([timing('quoted"\\request')], 'quoted"\\request'))
})
