// @vitest-environment node

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

test('answer editor model decodes grouped multiline answers before requesting the real file read', async () => {
  const { createQuestionAnswerEditorRegression, ANSWER_EDITOR_PROMPT } =
    await import('../e2e/desktop/modules/question-answer-editor.mjs')
  const fixture = createQuestionAnswerEditorRegression({ workspacePath: '/unused' })
  const path = '/workspace/attachments/question-editor-brief.txt'
  const user = text => ({ role: 'user', content: [{ type: 'input_text', text }] })
  const answers = {
    question_1: {
      answers: [
        'First line\nSecond line',
        `\n\n<attachment>\nAvailable attachments:\n- question-editor-brief.txt (text/plain, 26 bytes): ${path}\n</attachment>`,
      ],
    },
  }
  const body = {
    tools: ['exec_command', 'request_user_input_async'].map(name => ({
      type: 'function',
      name,
      parameters: { type: 'object' },
    })),
    input: [
      user(ANSWER_EDITOR_PROMPT),
      {
        type: 'function_call_output',
        call_id: 'answer-editor-question',
        output: JSON.stringify({ accepted: true }),
      },
      user(
        `Question answers:\n${JSON.stringify(answers, null, 2)}\n\n# User-provided text attachments\n\n## question-editor-brief.txt\nLocal File Path: ${path}\nMIME Type: text/plain\nSize: 26 bytes\n\nContent:\nWEWORK_QUESTION_FILE_BYTES`
      ),
    ],
  }
  const events = fixture.respond(body)
  const read = events.find(
    event =>
      event.type === 'response.output_item.done' && event.item?.call_id === 'answer-editor-read'
  )?.item
  assert.ok(read, 'The decoded multiline answer must advance to an actual file read')
  assert.equal(read.name, 'exec_command')
  assert.ok(JSON.parse(read.arguments).cmd.endsWith(`'${path}'`))
  const readResult = output => ({
    ...body,
    input: [...body.input, { type: 'function_call_output', call_id: 'answer-editor-read', output }],
  })
  assert.throws(
    () => fixture.respond(readResult('File read failed')),
    /The executor must read the pasted file bytes successfully/
  )
  assert.ok(
    fixture
      .respond(readResult('WEWORK_QUESTION_FILE_BYTES'))
      .some(event => event.item?.call_id === 'answer-editor-skip'),
    'Only the actual file read must advance to the optional question'
  )
})

test('cloud question attachment fixture requires each transport to read its own bytes', async () => {
  const { createCloudQuestionAttachments } =
    await import('../e2e/desktop/modules/cloud-question-attachments.mjs')
  const fixture = createCloudQuestionAttachments({ modelResponseTimeoutMs: 10000 })
  const user = text => ({ role: 'user', content: [{ type: 'input_text', text }] })
  const output = (callId, value) => ({
    type: 'function_call_output',
    call_id: callId,
    output: typeof value === 'string' ? value : JSON.stringify(value),
  })
  const body = {
    tools: ['exec_command', 'request_user_input', 'request_user_input_async'].map(name => ({
      type: 'function',
      name,
      parameters: { type: 'object' },
    })),
    input: [user('WEWORK_CLOUD_BLOCKING_QUESTION_FILES')],
  }
  const expected = [
    ['socket', 'CLOUD_BLOCKING_QUESTION_REAL_FILE_BYTES', 'brief'],
    ['blocking-http', 'CLOUD_HTTP_BLOCKING_QUESTION_REAL_BYTES', 'brief'],
    ['async-http', 'CLOUD_HTTP_ASYNC_QUESTION_REAL_BYTES', 'question_1'],
  ]
  for (const [kind, bytes, questionId] of expected) {
    const callId = `cloud-question-files-${kind}`
    const call = fixture.respond(body).find(event => event.item?.call_id === callId)?.item
    assert.equal(
      call?.name,
      kind === 'async-http' ? 'request_user_input_async' : 'request_user_input'
    )
    const path = `/remote/downloads/${kind}/cloud-question-brief.txt`
    const answers = {
      [questionId]: {
        answers: [
          'Review the remote brief',
          `<attachment>\nAvailable attachments:\n- cloud-question-brief.txt (text/plain, 40 bytes): ${path}\n</attachment>`,
        ],
      },
    }
    if (kind === 'async-http') {
      body.input.push(output(callId, { accepted: true }))
      const waiting = fixture.respond(body)
      assert.ok(
        waiting.some(event => event.item?.content?.[0]?.text === 'Waiting for the remote answer.')
      )
      body.input.push(user(`Question answers:\n${JSON.stringify(answers, null, 2)}`))
    } else body.input.push(output(callId, { answers }))
    const readId = `cloud-question-read-${kind}`
    const read = fixture
      .respond(body)
      .find(
        event => event.type === 'response.output_item.done' && event.item?.call_id === readId
      )?.item
    assert.equal(read?.name, 'exec_command')
    assert.ok(JSON.parse(read.arguments).cmd.endsWith(`'${path}'`))
    body.input.push(output(readId, 'WRONG_TRANSPORT_FILE_BYTES'))
    assert.throws(() => fixture.respond(body), new RegExp(`read the ${kind} uploaded bytes`))
    body.input.at(-1).output = bytes
  }
  assert.ok(
    fixture
      .respond(body)
      .some(event => event.item?.content?.[0]?.text === 'CLOUD_HTTP_QUESTION_FILES_COMPLETE')
  )
})
