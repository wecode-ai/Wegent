import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'vitest'
import { DesktopE2EServer } from '../e2e/desktop/modules/desktop-server.mjs'
import {
  MODEL_API_KEY,
  REQUEST_USER_INPUT_ASYNC_ANSWER,
  REQUEST_USER_INPUT_ASYNC_CALL_ID,
  REQUEST_USER_INPUT_ASYNC_COMPLETION_TEXT,
  REQUEST_USER_INPUT_ASYNC_PROMPT,
  REQUEST_USER_INPUT_ASYNC_WAITING_TEXT,
  REQUEST_USER_INPUT_FREE_TEXT_ANSWER,
  REQUEST_USER_INPUT_FREE_TEXT_COMPLETE,
  REQUEST_USER_INPUT_FREE_TEXT_PROMPT,
} from '../e2e/desktop/modules/shared.mjs'

function userMessage(text) {
  return { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
}

for (const fixture of [
  {
    name: 'suggested option',
    prompt: REQUEST_USER_INPUT_ASYNC_PROMPT,
    answer: REQUEST_USER_INPUT_ASYNC_ANSWER,
    callId: REQUEST_USER_INPUT_ASYNC_CALL_ID,
    waiting: REQUEST_USER_INPUT_ASYNC_WAITING_TEXT,
    completed: REQUEST_USER_INPUT_ASYNC_COMPLETION_TEXT,
  },
  {
    name: 'free text',
    prompt: REQUEST_USER_INPUT_FREE_TEXT_PROMPT,
    answer: REQUEST_USER_INPUT_FREE_TEXT_ANSWER,
    callId: 'wework-e2e-request-user-input-free-text',
    waiting: '等待回答',
    completed: REQUEST_USER_INPUT_FREE_TEXT_COMPLETE,
  },
]) {
  for (const answered of [false, true]) {
    test(`${fixture.name} only completes after the exact user answer: ${answered}`, async () => {
      const server = new DesktopE2EServer('/tmp/request-user-input-model-fixture')
      server.setScenario('request_user_input_async')
      const input = [
        userMessage(
          `# AGENTS.md instructions\nComplete root-cause investigation. Example answer: ${fixture.answer}`
        ),
        userMessage(fixture.prompt),
        { type: 'function_call_output', call_id: fixture.callId, output: '{"accepted":true}' },
      ]
      if (answered) input.push(userMessage(`  ${fixture.answer}\n`))
      const request = Readable.from([JSON.stringify({ input })])
      request.headers = { authorization: `Bearer ${MODEL_API_KEY}` }
      let events
      server.writeSse = (_response, value) => {
        events = value
      }
      await server.handleModelResponse(request, {}, 'responses')
      const message = events.find(event => event.item?.type === 'message')
      assert.equal(message.item.content[0].text, answered ? fixture.completed : fixture.waiting)
      assert.equal(events.at(-1).type, 'response.completed')
    })
  }
}
