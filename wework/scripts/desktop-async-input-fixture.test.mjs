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
} from '../e2e/desktop/modules/shared.mjs'

test.each([
  [false, REQUEST_USER_INPUT_ASYNC_WAITING_TEXT],
  [true, REQUEST_USER_INPUT_ASYNC_COMPLETION_TEXT],
])(
  'async fixture recognizes an explicit answer=%s among bootstrap instructions',
  async (answered, expected) => {
    const message = text => ({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    })
    const body = {
      input: [
        message('# AGENTS.md instructions\nComplete root-cause investigation before fixing.'),
        message(REQUEST_USER_INPUT_ASYNC_PROMPT),
        {
          type: 'function_call_output',
          call_id: REQUEST_USER_INPUT_ASYNC_CALL_ID,
          output: '{"accepted":true}',
        },
        ...(answered ? [message(REQUEST_USER_INPUT_ASYNC_ANSWER)] : []),
      ],
    }
    const request = Readable.from([JSON.stringify(body)])
    request.headers = { authorization: `Bearer ${MODEL_API_KEY}` }
    const server = new DesktopE2EServer('/tmp/desktop-async-input-fixture')
    server.setScenario('request_user_input_async')
    let events
    server.writeSse = (_response, value) => {
      events = value
    }
    await server.handleModelResponse(request, {}, 'responses')
    const reply = events.find(event => event.item?.type === 'message')
    assert.equal(reply.item.content[0].text, expected)
  }
)
