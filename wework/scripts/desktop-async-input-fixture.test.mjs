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

const user = text => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })

test('loads desktop checkpoints that consume the shared user message reader', async () => {
  await import('../e2e/desktop/modules/task-state-flows.mjs')
  await import('../e2e/desktop/modules/plugin-composer-route-messaging.mjs')
})

async function respond(input) {
  const server = new DesktopE2EServer('/tmp/async-input-fixture')
  server.scenario = 'request_user_input_async'
  const request = Readable.from([JSON.stringify({ input })])
  request.headers = { authorization: `Bearer ${MODEL_API_KEY}` }
  let events
  server.writeSse = (_response, value) => {
    events = value
  }
  await server.handleModelResponse(request, {}, 'responses')
  return events.find(event => event.item?.type === 'message').item.content[0].text
}

for (const fixture of [
  {
    name: 'option',
    prompt: REQUEST_USER_INPUT_ASYNC_PROMPT,
    callId: REQUEST_USER_INPUT_ASYNC_CALL_ID,
    answer: REQUEST_USER_INPUT_ASYNC_ANSWER,
    waiting: REQUEST_USER_INPUT_ASYNC_WAITING_TEXT,
    complete: REQUEST_USER_INPUT_ASYNC_COMPLETION_TEXT,
  },
  {
    name: 'free text',
    prompt: REQUEST_USER_INPUT_FREE_TEXT_PROMPT,
    callId: 'wework-e2e-request-user-input-free-text',
    answer: REQUEST_USER_INPUT_FREE_TEXT_ANSWER,
    waiting: '等待回答',
    complete: REQUEST_USER_INPUT_FREE_TEXT_COMPLETE,
  },
]) {
  const acknowledgement = {
    type: 'function_call_output',
    call_id: fixture.callId,
    output: JSON.stringify({ accepted: true }),
  }
  const history = [
    user(`# AGENTS.md instructions\nComplete root-cause investigation. ${fixture.answer}`),
    user(fixture.answer),
    user(fixture.prompt),
    {
      type: 'function_call',
      name: 'request_user_input_async',
      call_id: fixture.callId,
      arguments: JSON.stringify({
        questions: [{ title: 'Direction?', options: [fixture.answer] }],
      }),
    },
    acknowledgement,
  ]

  test(`${fixture.name}: injected instructions and earlier answers do not answer this question`, async () => {
    assert.equal(await respond(history), fixture.waiting)
  })

  test(`${fixture.name}: tool and assistant content after acknowledgement are not user replies`, async () => {
    assert.equal(
      await respond([
        ...history,
        { type: 'message', role: 'assistant', content: fixture.answer },
        {
          type: 'function_call_output',
          call_id: 'other-tool',
          output: fixture.answer,
          metadata: { quoted: user(fixture.answer) },
        },
      ]),
      fixture.waiting
    )
  })

  test(`${fixture.name}: mentioning the answer in a later sentence does not select it`, async () => {
    assert.equal(await respond([...history, user(`Context: ${fixture.answer}`)]), fixture.waiting)
  })

  for (const [format, content] of [
    ['plain text', fixture.answer],
    ['text parts', [{ type: 'input_text', text: ` ${fixture.answer}\n` }]],
    [
      'runtime context',
      `<application_context>Terminal state</application_context>\n${fixture.answer}`,
    ],
  ]) {
    test(`${fixture.name}: an actual reply completes the question (${format})`, async () => {
      assert.equal(
        await respond([...history, { type: 'message', role: 'user', content }]),
        fixture.complete
      )
    })
  }
}
