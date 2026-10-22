import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'vitest'
import { DesktopE2EServer } from '../e2e/desktop/modules/desktop-server.mjs'
import { CLOUD_VISION_SIDECAR_CASE, MODEL_API_KEY } from '../e2e/desktop/modules/shared.mjs'
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
    const body = {
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
