// @vitest-environment node

import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import {
  createAutoTaggedIssue,
  requestJson,
} from '../e2e/desktop/scenarios/collaboration-remote-agent-dispatch.scenario.mjs'

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

test('publishes the new Issue identity before its tag starts a model request', async () => {
  const popoverPending = Promise.withResolvers()
  const popoverClosed = Promise.withResolvers()
  let title
  let expectedIssue = { id: 'previous-issue' }
  let completed = false
  const issue = { id: 'auto-issue' }
  const rule = { id: 'auto-rule' }
  const request = vi.fn(async (_path, options) =>
    options?.method === 'POST' ? rule : { items: [{ ...issue, title }] }
  )
  const control = {
    command: vi.fn(async (action, selector, options) => {
      if (action === 'fill' && selector.endsWith('[data-testid="cloud-todo-title"]'))
        title = options.value
      if (action === 'getValue') return title
      if (action === 'press') {
        assert.equal(expectedIssue.id, issue.id, 'The immediate model call must see the new Issue')
      }
      if (action === 'waitFor' && selector.includes('more-properties-popover')) {
        popoverPending.resolve()
        await popoverClosed.promise
      }
      return ''
    }),
  }
  const creation = createAutoTaggedIssue(
    control,
    request,
    'project',
    { id: 'agent' },
    1000,
    item => {
      expectedIssue = item
    }
  ).then(result => {
    completed = true
    return result
  })

  try {
    await Promise.race([popoverPending.promise, creation])
    assert.equal(expectedIssue.id, issue.id)
    assert.equal(completed, false, 'The model can run before the UI helper returns')
    popoverClosed.resolve()
    assert.deepEqual(await creation, { issue: { ...issue, title }, rule })
  } finally {
    popoverClosed.resolve()
    await creation
  }
})
