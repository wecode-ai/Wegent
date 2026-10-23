import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import { requestJson } from '../e2e/desktop/scenarios/collaboration-remote-agent-dispatch.scenario.mjs'

afterEach(() => vi.unstubAllGlobals())

test('reports an upstream HTTP failure before attempting to decode its plain-text body', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response('fallback upstream unavailable', { status: 502 }))
  )

  await assert.rejects(
    requestJson('http://fixture.local', 'fixture-token', '/api/v1/cloud-projects/1/automations/2', {
      method: 'DELETE',
    }),
    /DELETE \/api\/v1\/cloud-projects\/1\/automations\/2 failed with HTTP 502: fallback upstream unavailable/
  )
})
