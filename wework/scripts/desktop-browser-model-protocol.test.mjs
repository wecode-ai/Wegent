// @vitest-environment node

import { Readable } from 'node:stream'
import { expect, test } from 'vitest'
import { DesktopE2EServer } from '../e2e/desktop/modules/desktop-server.mjs'
import {
  EMBEDDED_BROWSER_SETUP_PROMPT,
  EMBEDDED_BROWSER_SETUP_COMPLETION_TEXT,
  EMBEDDED_BROWSER_BRIDGE_COLLISION_PROMPT,
  EMBEDDED_BROWSER_BRIDGE_COLLISION_COMPLETION_TEXT,
  MODEL_API_KEY,
} from '../e2e/desktop/modules/shared.mjs'

const schema = {
  type: 'object',
  properties: { input: { type: 'string' } },
  required: ['input'],
  additionalProperties: false,
}
const variants = [
  { protocol: 'responses', tool: { type: 'custom', name: 'exec' } },
  { protocol: 'responses', tool: { type: 'function', name: 'exec', parameters: schema } },
  {
    protocol: 'anthropic',
    tool: { name: 'exec', description: 'Execute code', input_schema: schema },
  },
]
const scenarios = [
  {
    name: 'embedded_browser_setup',
    prompt: EMBEDDED_BROWSER_SETUP_PROMPT,
    completion: EMBEDDED_BROWSER_SETUP_COMPLETION_TEXT,
    id: 'wework-embedded-browser-setup-open',
  },
  {
    name: 'embedded_browser_bridge_collision',
    prompt: EMBEDDED_BROWSER_BRIDGE_COLLISION_PROMPT,
    completion: EMBEDDED_BROWSER_BRIDGE_COLLISION_COMPLETION_TEXT,
    id: 'wework-embedded-browser-bridge-collision-open',
  },
]

async function respond(server, protocol, body) {
  const request = Readable.from([JSON.stringify(body)])
  request.headers = { authorization: `Bearer ${MODEL_API_KEY}` }
  let wire
  await server.handleModelResponse(
    request,
    {
      writeHead(status) {
        expect(status).toBe(200)
      },
      end(value) {
        wire = value
      },
    },
    protocol
  )
  return wire
    .split('\n')
    .filter(line => line.startsWith('data: {'))
    .map(line => JSON.parse(line.slice(6)))
}

for (const { protocol, tool } of variants) {
  for (const scenario of scenarios) {
    test(`${scenario.name} returns native ${protocol}/${tool.type ?? 'input_schema'} exec and completion frames`, async () => {
      const server = new DesktopE2EServer('/tmp/browser-model-protocol')
      server.url = 'http://model-fixture'
      server.scenario = scenario.name
      const body = {
        model: 'desktop-e2e-cloud-anthropic-upstream',
        tools: [tool],
        ...(protocol === 'anthropic'
          ? { messages: [{ role: 'user', content: scenario.prompt }] }
          : { input: [{ role: 'user', content: scenario.prompt }] }),
      }
      const events = await respond(server, protocol, body)
      let script
      if (protocol === 'anthropic') {
        expect(events[0].type).toBe('message_start')
        const call = events.find(event => event.content_block?.type === 'tool_use').content_block
        expect(call).toMatchObject({ id: scenario.id, name: 'exec' })
        script = JSON.parse(
          events.find(event => event.delta?.type === 'input_json_delta').delta.partial_json
        ).input
      } else {
        expect(events[0].type).toBe('response.created')
        const call = events.find(event => event.type === 'response.output_item.done').item
        expect(call).toMatchObject({ call_id: scenario.id, name: 'exec' })
        script = call.type === 'custom_tool_call' ? call.input : JSON.parse(call.arguments).input
      }
      expect(script).toContain('await tools[browserOpen.name](')
      expect(script).toContain('/embedded-browser-agent-fixture')
      const output = 'Script completed\nWall time 0 seconds\nOutput:\n{"ok":true}'
      const history =
        protocol === 'anthropic'
          ? {
              ...body,
              messages: [
                ...body.messages,
                {
                  role: 'assistant',
                  content: [
                    { type: 'tool_use', id: scenario.id, name: 'exec', input: { input: script } },
                  ],
                },
                {
                  role: 'user',
                  content: [
                    {
                      type: 'tool_result',
                      tool_use_id: scenario.id,
                      content: [{ type: 'text', text: output }],
                    },
                  ],
                },
              ],
            }
          : {
              ...body,
              input: [
                ...body.input,
                { type: 'function_call_output', call_id: scenario.id, output },
              ],
            }
      const completion = await respond(server, protocol, history)
      expect(JSON.stringify(completion)).toContain(scenario.completion)
      expect(completion[0].type).toBe(
        protocol === 'anthropic' ? 'message_start' : 'response.created'
      )
    })
  }
}

test('Anthropic browser setup still rejects an unrelated or unsuccessful tool result', async () => {
  for (const { id, output, error } of [
    { id: 'unrelated', output: '{"ok":true}', error: 'output did not return' },
    { id: scenarios[0].id, output: '{"ok":false}', error: 'did not complete successfully' },
  ]) {
    const server = new DesktopE2EServer('/tmp/browser-model-protocol')
    server.url = 'http://model-fixture'
    server.scenario = scenarios[0].name
    const body = {
      model: 'desktop-e2e-cloud-anthropic-upstream',
      tools: [variants[2].tool],
      messages: [{ role: 'user', content: scenarios[0].prompt }],
    }
    await respond(server, 'anthropic', body)
    await expect(
      respond(server, 'anthropic', {
        ...body,
        messages: [
          ...body.messages,
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output }] },
        ],
      })
    ).rejects.toThrow(error)
  }
})
