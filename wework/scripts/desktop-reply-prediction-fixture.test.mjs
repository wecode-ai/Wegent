import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'vitest'
import { DesktopE2EServer } from '../e2e/desktop/modules/desktop-server.mjs'
import { createDesktopScenario as createTemporaryChatScenario } from '../e2e/desktop/scenarios/temporary-chat.scenario.mjs'
import {
  CLOUD_VISION_SIDECAR_CASE,
  LOCAL_CUSTOM_MODEL_PROTOCOL_MATRIX_CASES,
  MODEL_API_KEY,
} from '../e2e/desktop/modules/shared.mjs'
import {
  handleEmptyReplyPrediction,
  isReplyPredictionRequest,
  REPLY_PREDICTION_PROMPT,
} from '../e2e/desktop/modules/response-protocol.mjs'

function predictionMetadata(requestKind = 'turn') {
  return {
    'x-codex-turn-metadata': JSON.stringify({
      thread_source: 'composer_predictions',
      request_kind: requestKind,
    }),
  }
}

async function activeTemporaryChatScenario() {
  const scenario = createTemporaryChatScenario({ uiTimeoutMs: 100 })
  const stopBeforeUi = new Error('Stop before desktop UI setup')
  await assert.rejects(
    scenario.verify({
      async command() {
        throw stopBeforeUi
      },
    }),
    error => error === stopBeforeUi
  )
  return scenario
}

function memoryResponse() {
  return {
    status: null,
    output: '',
    writeHead(status) {
      this.status = status
    },
    flushHeaders() {
      assert.fail('A prediction entered the held conversation response')
    },
    end(output) {
      this.output = output
    },
    events() {
      return this.output
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => JSON.parse(line.slice(6)))
    },
  }
}

test.each([
  ['native turn', '/v1/responses', 'turn'],
  ['native compaction', '/responses', 'compaction'],
  ['converted messages', '/responses', null],
])('routes %s predictions before temporary-chat history markers', async (_label, path, kind) => {
  const scenario = await activeTemporaryChatScenario()
  const history = [
    'TEMPORARY_CHAT_SOURCE_CONVERSATION',
    'TEMPORARY_CHAT_INITIAL_MESSAGE',
    'TEMPORARY_CHAT_DIRECT_FOLLOW_UP',
    REPLY_PREDICTION_PROMPT,
  ].map(content => ({ role: 'user', content }))
  const body = kind
    ? { client_metadata: predictionMetadata(kind), input: history }
    : { messages: history }
  const request = Readable.from([JSON.stringify(body)])
  request.method = 'POST'
  const response = memoryResponse()

  assert.equal(await scenario.handleHttp(request, response, new URL(path, 'http://fixture')), true)
  assert.equal(response.status, 200)
  const events = response.events()
  assert.equal(events.at(-1).type, 'response.completed')
  const message = events.find(event => event.item?.type === 'message')
  assert.deepEqual(JSON.parse(message.item.content[0].text), { suggestion: null })
})

test('preserves foreground temporary-chat responses after a prediction in history', async () => {
  const scenario = await activeTemporaryChatScenario()
  const request = Readable.from([
    JSON.stringify({
      messages: [
        { role: 'user', content: REPLY_PREDICTION_PROMPT },
        { role: 'assistant', content: '{"suggestion":null}' },
        { role: 'user', content: 'TEMPORARY_CHAT_INITIAL_MESSAGE' },
      ],
    }),
  ])
  request.method = 'POST'
  const response = memoryResponse()

  assert.equal(
    await scenario.handleHttp(request, response, new URL('http://fixture/v1/responses')),
    true
  )
  const message = response.events().find(event => event.item?.type === 'message')
  assert.equal(message.item.content[0].text, 'TEMPORARY_CHAT_INITIAL_COMPLETE')
})

function visionBody(context) {
  return {
    model: CLOUD_VISION_SIDECAR_CASE.sidecarModelId,
    stream: false,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: `Describe this image.\n\nThe user's request:\n\n${context}` },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } },
        ],
      },
    ],
  }
}

test('recognizes prediction turns and compaction from their native thread source', () => {
  for (const kind of ['turn', 'compaction']) {
    assert.equal(isReplyPredictionRequest({ client_metadata: predictionMetadata(kind) }), true)
  }
  assert.equal(isReplyPredictionRequest({ input: 'Predict one natural next USER message' }), false)
  assert.equal(isReplyPredictionRequest({ client_metadata: {} }), false)
  assert.equal(
    isReplyPredictionRequest({ client_metadata: { 'x-codex-turn-metadata': 'invalid' } }),
    false
  )
})

test('returns an empty prediction response without consuming ordinary scenario requests', () => {
  let status
  let output
  const response = {
    writeHead(value) {
      status = value
    },
    end(value) {
      output = value
    },
  }
  assert.equal(handleEmptyReplyPrediction({ input: 'Continue the task' }, response), false)
  assert.equal(output, undefined)
  assert.equal(
    handleEmptyReplyPrediction({ client_metadata: predictionMetadata() }, response),
    true
  )
  assert.equal(status, 200)
  const events = output
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)))
  assert.equal(events.at(-1).type, 'response.completed')
  const message = events.find(event => event.item?.type === 'message')
  assert.deepEqual(JSON.parse(message.item.content[0].text), { suggestion: null })
})

test('recognizes converted Chat and Anthropic predictions without native metadata', () => {
  for (const content of [
    REPLY_PREDICTION_PROMPT,
    [{ type: 'text', text: REPLY_PREDICTION_PROMPT }],
  ]) {
    const prediction = { role: 'user', content }
    assert.equal(isReplyPredictionRequest({ messages: [prediction] }), true)
    assert.equal(
      isReplyPredictionRequest({ messages: [prediction, { role: 'user', content: 'Continue' }] }),
      false
    )
    assert.equal(isReplyPredictionRequest({ messages: [{ role: 'assistant', content }] }), false)
  }
  assert.equal(
    isReplyPredictionRequest({
      messages: [{ role: 'user', content: 'Predict one natural next USER message' }],
    }),
    false
  )
})

test('serves background predictions without advancing the active tool scenario', async () => {
  const server = new DesktopE2EServer('/tmp/reply-prediction-fixture')
  server.scenario = 'embedded_browser_setup'
  const body = {
    client_metadata: predictionMetadata(),
    input: [
      { role: 'user', content: 'Open the browser' },
      { role: 'assistant', content: 'Browser opened' },
      {
        role: 'user',
        content: 'Predict one natural next USER message based on the conversation above.',
      },
    ],
  }
  const request = Readable.from([JSON.stringify(body)])
  request.headers = { authorization: `Bearer ${MODEL_API_KEY}` }
  let events
  server.writeSse = (_response, value) => {
    events = value
  }

  await server.handleModelResponse(request, {}, 'responses')

  assert.equal(server.modelRequests.length, 1)
  assert.equal(server.scenarioRequests.has('embedded_browser_setup'), false)
  assert.equal(events.at(-1).type, 'response.completed')
  const message = events.find(event => event.item?.type === 'message')
  assert.deepEqual(JSON.parse(message.item.content[0].text), { suggestion: null })
})

test('keeps prediction image descriptions separate from conversation cache assertions', async () => {
  const server = new DesktopE2EServer('/tmp/reply-prediction-vision-fixture')
  server.scenario = 'vision_sidecar'
  for (const context of ['Describe the attached image', REPLY_PREDICTION_PROMPT]) {
    const body = visionBody(context)
    const request = Readable.from([JSON.stringify(body)])
    request.headers = { authorization: `Bearer ${MODEL_API_KEY}` }
    let output
    const response = {
      writeHead(status) {
        assert.equal(status, 200)
      },
      end(value) {
        output = JSON.parse(value)
      },
    }

    await server.handleModelResponse(request, response, 'chat')

    assert.ok(output.choices[0].message.content)
  }
  assert.deepEqual(
    server.visionSidecarRequests.map(request => request.kind),
    ['vision', 'prediction-vision']
  )
})

test('serves late prediction image descriptions without consuming the active protocol matrix', async () => {
  const server = new DesktopE2EServer('/tmp/reply-prediction-late-vision-fixture')
  server.setMatrixCase(
    LOCAL_CUSTOM_MODEL_PROTOCOL_MATRIX_CASES.find(model => model.protocol === 'responses')
  )
  const request = Readable.from([JSON.stringify(visionBody(REPLY_PREDICTION_PROMPT))])
  request.headers = { authorization: `Bearer ${MODEL_API_KEY}` }
  let output
  const response = {
    writeHead(status) {
      assert.equal(status, 200)
    },
    end(value) {
      output = JSON.parse(value)
    },
  }

  await server.handleModelResponse(request, response, 'chat')

  assert.ok(output.choices[0].message.content)
  assert.equal(server.scenario, 'model_protocol_matrix')
  assert.equal(server.matrixState.stage, 'text')
  assert.deepEqual(server.matrixState.requests, [])
  assert.deepEqual(
    server.visionSidecarRequests.map(row => row.kind),
    ['prediction-vision']
  )
  const foreground = Readable.from([JSON.stringify(visionBody('Describe the attached image'))])
  foreground.headers = { authorization: `Bearer ${MODEL_API_KEY}` }
  await assert.rejects(
    server.handleModelResponse(foreground, response, 'chat'),
    /local-local-responses reached the wrong endpoint/
  )
})
