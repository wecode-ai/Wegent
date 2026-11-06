// @vitest-environment node

import { Readable } from 'node:stream'
import { describe, expect, test } from 'vitest'
import { createDesktopScenario } from '../e2e/desktop/scenarios/stand-in-model-interface.scenario.mjs'
import { MODEL_API_KEY } from '../e2e/desktop/modules/shared.mjs'
import { REPLY_PREDICTION_PROMPT } from '../e2e/desktop/modules/response-protocol.mjs'

async function respond(input, tools = [], requestKind, extra = {}) {
  const request = Readable.from([
    JSON.stringify({
      model: 'stand-in-interface-upstream',
      input,
      tools,
      ...extra,
      ...(requestKind
        ? {
            client_metadata: {
              'x-codex-turn-metadata': JSON.stringify({ request_kind: requestKind }),
            },
          }
        : {}),
    }),
  ])
  request.method = 'POST'
  request.headers = { authorization: `Bearer ${MODEL_API_KEY}` }
  let output
  const handled = await createDesktopScenario({}).handleHttp(
    request,
    {
      writeHead() {},
      end(value) {
        output = value
      },
    },
    new URL('http://localhost/v1/story-model/responses')
  )
  expect(handled).toBe(true)
  return output
}

describe('stand-in custom interface model fixture', () => {
  test('uses the native direct MCP name for a primary model-interface request', async () => {
    const output = await respond(
      [
        {
          role: 'developer',
          content: 'Attempt missing data-source connections with connect_source',
        },
        { role: 'user', content: 'STAND_IN_MODEL_INTERFACE_CHAT' },
      ],
      [{ type: 'function', name: 'wework_stand_in__list_tasks' }]
    )
    expect(output).toContain('wework_stand_in__list_tasks')
    expect(output).toContain('interface-list')
    expect(output).not.toContain('interface-list-search')
    expect(output).not.toContain('tool_search_call')
  })

  test('uses the native approval model protocol for a guardian quoting worker history', async () => {
    const output = await respond(
      [{ role: 'user', content: 'STAND_IN_MODEL_INTERFACE_WORK' }],
      [],
      undefined,
      {
        client_metadata: {
          'x-codex-turn-metadata': JSON.stringify({
            request_kind: 'turn',
            thread_source: 'guardian_review',
          }),
        },
        text: {
          format: {
            schema: {
              properties: {
                risk_level: {},
                user_authorization: {},
                rationale: {},
                outcome: { enum: ['allow', 'deny'] },
              },
            },
          },
        },
      }
    )
    expect(output).toContain('allow')
    expect(output).toContain('risk_level')
    expect(output).not.toContain('tool_search_call')
  })

  test.each(['compaction', 'prewarm'])(
    'handles %s quoting worker history without inventing a business tool call',
    async kind => {
      const output = await respond(
        [{ role: 'user', content: 'STAND_IN_MODEL_INTERFACE_WORK STAND_IN_MODEL_INTERFACE_CHAT' }],
        [],
        kind
      )
      expect(output).toContain('response.completed')
      expect(output).not.toContain('tool_search_call')
      expect(output).not.toContain('function_call')
    }
  )

  test('still rejects a real business request missing its advertised tools', async () => {
    await expect(
      respond([
        {
          role: 'developer',
          content: 'Attempt missing data-source connections with connect_source',
        },
        { role: 'user', content: 'STAND_IN_MODEL_INTERFACE_CHAT' },
      ])
    ).rejects.toThrow('Real Codex did not advertise exactly one deferred tool search')
  })

  test('does not mistake a composer prediction quoting worker history for a worker tool call', async () => {
    const output = await respond([
      { role: 'user', content: 'STAND_IN_MODEL_INTERFACE_WORK' },
      { role: 'user', content: REPLY_PREDICTION_PROMPT },
    ])
    expect(output).toContain('suggestion')
    expect(output).toContain('null')
    expect(output).not.toContain('tool_search_call')
  })

  test('reads the exact completed child on its result wake instead of replaying creation', async () => {
    const output = await respond(
      [
        { role: 'user', content: 'STAND_IN_MODEL_INTERFACE_CHAT' },
        {
          role: 'user',
          content:
            'Wework delegated task result: resultId=stand-in-result:one, taskId=child-one, status=done, errorCode=none',
        },
      ],
      [{ type: 'tool_search' }]
    )
    expect(output).toContain('read_task')
    expect(output).not.toContain('create_task')
  })
})
