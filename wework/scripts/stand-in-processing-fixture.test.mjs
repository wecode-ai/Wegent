// @vitest-environment node

import { Readable } from 'node:stream'
import { describe, expect, test } from 'vitest'
import { createDesktopScenario } from '../e2e/desktop/scenarios/stand-in-processing.scenario.mjs'
import { createDesktopScenario as createCalendarScenario } from '../e2e/desktop/scenarios/serialized-calendar-arrangements.scenario.mjs'
import { createDesktopScenario as createEmailScenario } from '../e2e/desktop/scenarios/stand-in-email.scenario.mjs'

async function respond(input, { tools = [], kind } = {}) {
  const request = Readable.from([
    JSON.stringify({
      input,
      tools,
      ...(kind
        ? { client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ request_kind: kind }) } }
        : {}),
    }),
  ])
  request.method = 'POST'
  let output
  const handled = await createDesktopScenario({}).handleHttp(
    request,
    {
      writeHead() {},
      end(value) {
        output = value
      },
    },
    new URL('http://localhost/v1/responses')
  )
  expect(handled).toBe(true)
  return output
}

describe('stand-in processing model fixture', () => {
  test('runs the child prompt when Codex renders recalled parent history as a user message', async () => {
    const output = await respond(
      [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '[tool_result without a matching tool_call]' },
            {
              type: 'input_text',
              text: '{"items":[{"excerpt":"PRIMARY_ORCHESTRATE_TASK_CREATE"}]}',
            },
          ],
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'PRIMARY_CONCRETE_WORK' }],
        },
      ],
      { tools: [{ type: 'custom', name: 'exec' }] }
    )
    expect(output).toContain('PRIMARY_CONCRETE_DONE')
    expect(output).not.toContain('create_task')
  })

  test('continues the existing task when the primary history contains an earlier create request', async () => {
    const output = await respond(
      [
        { role: 'user', content: 'PRIMARY_ORCHESTRATE_TASK_CREATE' },
        { role: 'assistant', content: '已创建独立处理任务。' },
        { role: 'user', content: 'PRIMARY_ORCHESTRATE_TASK_CONTINUE' },
      ],
      { tools: [{ type: 'custom', name: 'exec' }] }
    )
    expect(output).toContain('wework_stand_in__continue_task')
    expect(output).not.toContain('wework_stand_in__create_task')
  })

  test.each(['string', 'parts', 'agent-output'])(
    'quoted parent recall (%s) cannot route a read-only worker to create another task',
    async format => {
      const recall =
        '<external_wework.stand-in.recall>{"items":[{"excerpt":"PRIMARY_ORCHESTRATE_TASK_CREATE"}]}</external_wework.stand-in.recall>'
      const output = await respond(
        [
          {
            ...(format === 'agent-output'
              ? {
                  type: 'function_call_output',
                  namespace: 'agent',
                  name: 'weworkstandinrecall',
                  output: JSON.stringify({
                    items: [{ excerpt: 'PRIMARY_ORCHESTRATE_TASK_CREATE' }],
                  }),
                }
              : {
                  role: 'user',
                  content: format === 'string' ? recall : [{ type: 'input_text', text: recall }],
                }),
          },
          { role: 'user', content: 'PRIMARY_CONCRETE_WORK' },
        ],
        { tools: [{ type: 'tool_search' }] }
      )
      expect(output).toContain('PRIMARY_CONCRETE_DONE')
      expect(output).not.toContain('create_task')
      expect(output).not.toContain('continue_task')
    }
  )

  test.each([
    ['calendar', createCalendarScenario, 'CALENDAR_SERIAL_QUEUE_WORK'],
    ['email', createEmailScenario, 'EMAIL_INTAKE_USER_STORY'],
  ])(
    '%s result delivery uses actual child history instead of replaying source work',
    async (name, create, marker) => {
      const scenario = create({ executorHome: '/unused-model-fixture' })
      const request = Readable.from([
        JSON.stringify({
          input: [
            { role: 'user', content: marker },
            {
              role: 'user',
              content:
                'Wework delegated task result: resultId=calendar-result, taskId=calendar-child, status=done, errorCode=none',
            },
          ],
          tools: [{ type: 'tool_search' }],
        }),
      ])
      request.method = 'POST'
      let output
      expect(
        await scenario.handleHttp(
          request,
          {
            writeHead() {},
            end(value) {
              output = value
            },
          },
          new URL('http://localhost/v1/responses')
        )
      ).toBe(true)
      expect(output).toContain('read_task')
      expect(output).not.toContain('read_work')
      if (name === 'calendar') expect(scenario.diagnostics().calls).toBe(0)
    }
  )

  test('reads a result wake instead of repeating the historical orchestration request', async () => {
    const output = await respond(
      [
        { role: 'user', content: 'PRIMARY_ORCHESTRATE_TASK_CREATE' },
        {
          role: 'user',
          content:
            'Wework delegated task result: resultId=stand-in-result:processing, taskId=child, status=done, errorCode=none',
        },
      ],
      { tools: [{ type: 'tool_search' }] }
    )
    expect(output).toContain('read_task')
    expect(output).not.toContain('create_task')
  })

  test.each(['compaction', 'prewarm'])(
    'does not interpret %s history as another orchestration request',
    async kind => {
      const output = await respond([{ role: 'user', content: 'PRIMARY_ORCHESTRATE_TASK_CREATE' }], {
        kind,
      })
      expect(output).toContain('response.completed')
      expect(output).not.toContain('tool_search_call')
    }
  )
})
