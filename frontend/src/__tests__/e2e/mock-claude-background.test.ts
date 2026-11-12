/** @jest-environment node */

import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { handleClaudeBackgroundRequest } from '../../../e2e/utils/mock-claude-background'
import { withMockScope } from '../../../e2e/utils/mock-scope'

function request(scope: string, path: string, body?: unknown) {
  const response = Object.assign(new EventEmitter(), {
    writeHead: jest.fn(),
    end: jest.fn(),
  })
  const req = { url: path, method: body === undefined ? 'GET' : 'POST' } as IncomingMessage
  const handled = withMockScope(scope, () =>
    handleClaudeBackgroundRequest(req, response as unknown as ServerResponse, JSON.stringify(body))
  )
  expect(handled).toBe(true)
  return response
}

function result(response: ReturnType<typeof request>) {
  expect(response.end).toHaveBeenCalledTimes(1)
  return JSON.parse(response.end.mock.calls[0][0])
}

it('isolates large-output child gates and completion notifications across workers', () => {
  const model = 'same-large-output-model'
  const parent = {
    model,
    messages: [{ role: 'user', content: 'Start the background worker' }],
    tools: [{ name: 'Agent', input_schema: { properties: { run_in_background: {} } } }],
  }
  const child = { model, messages: [{ role: 'user', content: `BG_WORKER_${model}` }] }
  const state = (scope: string) =>
    result(request(scope, `/claude-background-scenarios?model=${model}`))
  const complete = (scope: string, taskId: string) =>
    request(scope, '/v1/messages', {
      model,
      messages: [
        {
          role: 'user',
          content: `agentId: child-agent\n<task-notification><task-id>${taskId}</task-id><status>completed</status><summary>BG_LARGE_CHILD_${model}</summary></task-notification>`,
        },
      ],
    })

  for (const scope of ['large-a', 'large-b']) {
    request(scope, '/claude-background-scenarios', { model, mode: 'large-output' })
    expect(result(request(scope, '/v1/messages', parent)).content[0].name).toBe('Agent')
  }
  const childA = request('large-a', '/v1/messages', child)
  const childB = request('large-b', '/v1/messages', child)
  expect(childA.end).not.toHaveBeenCalled()
  expect(childB.end).not.toHaveBeenCalled()

  const parentA = request('large-a', '/v1/messages', parent)
  expect(result(parentA).content[0].text).toBe(`BG_LARGE_PARENT_WAITING_${model}`)
  expect(childA.end).not.toHaveBeenCalled()
  // A response event must retain its originating gate even under another request's scope.
  withMockScope('large-b', () => parentA.emit('finish'))
  const outputA = result(childA).content[0].text
  expect(outputA).toBe(
    `BG_LARGE_CHILD_${model}${'x'.repeat(1100 * 1024)}BG_LARGE_CHILD_${model}_END`
  )
  expect(childB.end).not.toHaveBeenCalled()
  expect(state('large-b')).toMatchObject({ parentYielded: false, childFinished: false })
  expect(result(complete('large-a', 'child-agent')).content[0].text).toBe(
    `BG_LARGE_PARENT_DONE_${model}`
  )

  const parentB = request('large-b', '/v1/messages', parent)
  withMockScope('large-a', () => parentB.emit('finish'))
  expect(result(childB).content[0].text).toBe(outputA)
  const rejected = complete('large-b', 'another-agent')
  expect(rejected.writeHead).toHaveBeenCalledWith(400, expect.anything())
  expect(result(rejected).error.message).toContain('completion notification was not received')
  expect(state('large-a')).toMatchObject({ completionReceived: true, parentCalls: 3 })
  expect(state('large-b')).toMatchObject({ completionReceived: false, parentCalls: 3 })
  expect(result(complete('large-b', 'child-agent')).content[0].text).toBe(
    `BG_LARGE_PARENT_DONE_${model}`
  )
})
