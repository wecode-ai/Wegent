import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
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

test('desktop model fixture loads without native TypeScript support', async () => {
  const moduleUrl = new URL('../e2e/desktop/modules/desktop-server.mjs', import.meta.url).href
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--no-experimental-strip-types',
    '--input-type=module',
    '-e',
    `const { DesktopE2EServer } = await import(${JSON.stringify(moduleUrl)}); console.log(typeof DesktopE2EServer)`,
  ])
  assert.equal(stdout.trim(), 'function')
})

test.each([
  ['unanswered', null, REQUEST_USER_INPUT_ASYNC_WAITING_TEXT],
  ['another option', 'Minimal', REQUEST_USER_INPUT_ASYNC_WAITING_TEXT],
  ['answered', REQUEST_USER_INPUT_ASYNC_ANSWER, REQUEST_USER_INPUT_ASYNC_COMPLETION_TEXT],
  [
    'answered with application context',
    '<application_context>Terminal state</application_context>\nComplete',
    REQUEST_USER_INPUT_ASYNC_COMPLETION_TEXT,
  ],
  [
    'another option with the answer in application context',
    '<application_context>Complete</application_context>\nMinimal',
    REQUEST_USER_INPUT_ASYNC_WAITING_TEXT,
  ],
])('async fixture recognizes only the user answer: %s', async (_name, answer, expected) => {
  const server = new DesktopE2EServer('/tmp/async-question-fixture')
  server.scenario = 'request_user_input_async'
  const user = text => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
  const body = {
    input: [
      user('# AGENTS.md\nComplete root-cause investigation before changing behavior.'),
      user(REQUEST_USER_INPUT_ASYNC_PROMPT),
      {
        type: 'function_call_output',
        call_id: REQUEST_USER_INPUT_ASYNC_CALL_ID,
        output: JSON.stringify({ accepted: true }),
      },
      ...(answer === null ? [] : [user(answer)]),
    ],
  }
  const request = Readable.from([JSON.stringify(body)])
  request.headers = { authorization: `Bearer ${MODEL_API_KEY}` }
  let events
  server.writeSse = (_response, value) => {
    events = value
  }

  await server.handleModelResponse(request, {}, 'responses')

  assert.equal(events.at(-1).type, 'response.completed')
  const message = events.find(event => event.item?.type === 'message')
  assert.equal(message.item.content[0].text, expected)
})
