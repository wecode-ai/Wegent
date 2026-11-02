import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
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
  REQUEST_USER_INPUT_FREE_TEXT_ANSWER,
  REQUEST_USER_INPUT_FREE_TEXT_COMPLETE,
  REQUEST_USER_INPUT_FREE_TEXT_PROMPT,
} from '../e2e/desktop/modules/shared.mjs'

test('desktop model fixture loads without native TypeScript support', async () => {
  const moduleUrl = pathToFileURL(
    resolve(import.meta.dirname, '../e2e/desktop/modules/desktop-server.mjs')
  ).href
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--no-experimental-strip-types',
    '--input-type=module',
    '-e',
    `const { DesktopE2EServer } = await import(${JSON.stringify(moduleUrl)}); console.log(typeof DesktopE2EServer)`,
  ])
  assert.equal(stdout.trim(), 'function')
})

for (const fixture of [
  {
    name: 'option',
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
  test.each([
    ['unanswered', null, fixture.waiting],
    ['another option', 'Minimal', fixture.waiting],
    ['answered', fixture.answer, fixture.completed],
    ['answered with whitespace', '  ' + fixture.answer + '\n', fixture.completed],
    [
      'answered with application context',
      '<application_context>Terminal state</application_context>\n' + fixture.answer,
      fixture.completed,
    ],
    [
      'another option with the answer in application context',
      '<application_context>' + fixture.answer + '</application_context>\nMinimal',
      fixture.waiting,
    ],
  ])(fixture.name + ' recognizes only the user answer: %s', async (_name, answer, expected) => {
    const server = new DesktopE2EServer('/tmp/async-question-fixture')
    server.scenario = 'request_user_input_async'
    const user = text => ({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    })
    const body = {
      input: [
        user('# AGENTS.md\nComplete root-cause investigation. Example answer: ' + fixture.answer),
        user(fixture.prompt),
        {
          type: 'function_call_output',
          call_id: fixture.callId,
          output: JSON.stringify({ accepted: true }),
        },
        ...(answer === null ? [] : [user(answer)]),
      ],
    }
    const request = Readable.from([JSON.stringify(body)])
    request.headers = { authorization: 'Bearer ' + MODEL_API_KEY }
    let events
    server.writeSse = (_response, value) => {
      events = value
    }
    await server.handleModelResponse(request, {}, 'responses')
    assert.equal(events.at(-1).type, 'response.completed')
    const message = events.find(event => event.item?.type === 'message')
    assert.equal(message.item.content[0].text, expected)
  })
}
