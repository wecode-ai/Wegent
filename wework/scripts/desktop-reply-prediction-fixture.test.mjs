import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'vitest'
import { DesktopE2EServer } from '../e2e/desktop/modules/desktop-server.mjs'
import { MODEL_API_KEY } from '../e2e/desktop/modules/shared.mjs'
import {
  handleEmptyReplyPrediction,
  isReplyPredictionRequest,
} from '../e2e/desktop/modules/response-protocol.mjs'

test('recognizes predictions only in the latest model input', () => {
  const prediction = { role: 'user', content: 'Predict one natural next USER message' }
  assert.equal(isReplyPredictionRequest({ input: [prediction] }), true)
  assert.equal(isReplyPredictionRequest({ messages: [prediction] }), true)
  assert.equal(
    isReplyPredictionRequest({ input: [prediction, { role: 'user', content: 'Continue' }] }),
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
    handleEmptyReplyPrediction({ input: 'Predict one natural next USER message' }, response),
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

test('serves background predictions without advancing the active tool scenario', async () => {
  const server = new DesktopE2EServer('/tmp/reply-prediction-fixture')
  server.scenario = 'embedded_browser_setup'
  const body = {
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
