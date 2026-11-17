// @vitest-environment node
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'vitest'
import { DesktopE2EServer } from '../e2e/desktop/modules/desktop-server.mjs'
import {
  MODEL_API_KEY,
  CONNECTOR_AUTH_UNMATCHED_RESUME_PROMPT,
  CONNECTOR_AUTH_UNMATCHED_RESUME_COMPLETION_TEXT,
  PLUGIN_CREATOR_PROMPT,
  PLUGIN_CREATOR_COMPLETION_TEXT,
  PLUGIN_REFINEMENT_PROMPT,
  PLUGIN_REFINEMENT_COMPLETION_TEXT,
} from '../e2e/desktop/modules/shared.mjs'

const readyWorkspace = '[WEGENT_PLUGIN_RESULT]{"status":"ready"}'

for (const [name, prompt, completion, scenario] of [
  ['workspace result', readyWorkspace, readyWorkspace],
  [
    'recovery',
    CONNECTOR_AUTH_UNMATCHED_RESUME_PROMPT,
    CONNECTOR_AUTH_UNMATCHED_RESUME_COMPLETION_TEXT,
    'connector_auth_unmatched_resume',
  ],
  ['creator', PLUGIN_CREATOR_PROMPT, PLUGIN_CREATOR_COMPLETION_TEXT],
  ['refinement', PLUGIN_REFINEMENT_PROMPT, PLUGIN_REFINEMENT_COMPLETION_TEXT],
]) {
  for (const protocol of ['responses', 'chat', 'anthropic']) {
    test(`${name} replies retain the selected ${protocol} wire protocol`, async () => {
      const server = new DesktopE2EServer('/isolated-model-message-fixture')
      if (scenario) server.scenario = scenario
      const message = { role: 'user', content: prompt }
      const body = protocol === 'responses' ? { input: [message] } : { messages: [message] }
      const request = Readable.from([JSON.stringify(body)])
      request.headers = { authorization: `Bearer ${MODEL_API_KEY}` }
      let output = ''
      await server.handleModelResponse(
        request,
        {
          writeHead(status, headers) {
            assert.equal(status, 200)
            assert.match(headers['Content-Type'], /text\/event-stream/)
          },
          end(value) {
            output = value
          },
        },
        protocol
      )
      const data = output
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => line.slice(6))
      const events = data.filter(line => line !== '[DONE]').map(line => JSON.parse(line))
      if (protocol === 'responses') {
        assert.equal(events.at(-1).type, 'response.completed')
        const message = events.find(event => event.type === 'response.output_item.done').item
        assert.equal(message.content[0].text, completion)
      } else if (protocol === 'chat') {
        assert.equal(data.at(-1), '[DONE]')
        assert.equal(events.at(-1).choices[0].finish_reason, 'stop')
        assert.equal(events[0].choices[0].delta.content, completion)
      } else {
        assert.equal(events[0].type, 'message_start')
        assert.equal(events.at(-1).type, 'message_stop')
        assert.equal(
          events.find(event => event.type === 'content_block_delta').delta.text,
          completion
        )
        assert.equal(
          events.find(event => event.type === 'message_delta').delta.stop_reason,
          'end_turn'
        )
      }
    })
  }
}
