import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'

import { createRuntimeReconciliationModel } from '../e2e/desktop/modules/runtime-reconciliation-model.mjs'

const MARKER = 'RUNTIME_RECONCILIATION_HTTP_TEST'
const ORDERS = ['snapshot-first', 'event-first', 'terminal-interleaved']

function userInput(text) {
  return { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
}

function assignmentPrompt(issueId) {
  return [
    'project_id: 5155269154435544475',
    `task_id: ${issueId}`,
    'execution_id: 1',
    '',
    `看板任务数据位于 cloud://projects/5155269154435544475/todos/${issueId}，请通过看板工具自行查看。`,
  ].join('\n')
}

function modelRequest(input, extra = {}) {
  return {
    model: 'gpt-5.6-luna',
    stream: true,
    instructions: `${MARKER}: finish the assigned Issue directly without tools.`,
    input,
    ...extra,
  }
}

function sseEvents(text) {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map(event =>
      JSON.parse(
        event
          .split('\n')
          .find(line => line.startsWith('data: '))
          .slice(6)
      )
    )
}

async function fixture(t) {
  const model = createRuntimeReconciliationModel({ marker: MARKER, orders: ORDERS })
  const sockets = new Set()
  const server = createServer(async (request, response) => {
    try {
      if (!(await model.handleHttp(request, response, new URL(request.url, 'http://localhost')))) {
        response.writeHead(404)
        response.end()
      }
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error)
        return
      }
      response.writeHead(500, { 'content-type': 'text/plain' })
      response.end(error.message)
    }
  })
  t.after(async () => {
    model.release()
    for (const socket of sockets) socket.destroy()
    if (server.listening) await new Promise(resolve => server.close(resolve))
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}/v1/responses`
  return {
    model,
    request(body) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3_000),
      })
    },
  }
}

async function expectGatedStream(response, testCase, continuation = false) {
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let initialText = ''
  let initialEvents = []
  while (initialEvents.at(-1)?.type !== 'response.output_text.delta') {
    const chunk = await reader.read()
    assert.equal(chunk.done, false, 'The model ended before sending its gated prefix')
    initialText += decoder.decode(chunk.value, { stream: true })
    const boundary = initialText.lastIndexOf('\n\n')
    initialEvents = boundary < 0 ? [] : sseEvents(initialText.slice(0, boundary + 2))
  }
  assert.equal(initialEvents[0].type, 'response.created')
  assert.equal(initialEvents.at(-1).type, 'response.output_text.delta')
  assert.equal(initialEvents.at(-1).delta, continuation ? testCase.continuePrefix : testCase.prefix)
  assert.equal(
    initialEvents.some(event => event.type === 'response.completed'),
    false
  )
  const gate = continuation ? testCase.continueGate : testCase.initialGate
  gate.resolve()
  let remaining = ''
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    remaining += decoder.decode(chunk.value, { stream: true })
  }
  remaining += decoder.decode()
  const finalEvents = sseEvents(remaining)
  const fullText = continuation ? testCase.continueText : testCase.text
  assert.equal(finalEvents.find(event => event.type === 'response.output_text.done').text, fullText)
  assert.equal(finalEvents.at(-1).type, 'response.completed')
  assert.equal(finalEvents.at(-1).response.output[0].content[0].text, fullText)
}

test('assignment cloud references select the exact registered Issue without its title', async t => {
  const { model, request } = await fixture(t)
  for (const [index, id] of ['RACE-1', 'RACE-10', 'RACE-2'].entries()) {
    model.cases[index].issue = { id }
  }
  for (const testCase of [model.cases[1], model.cases[0], model.cases[2]]) {
    const body = modelRequest([userInput(assignmentPrompt(testCase.issue.id))])
    assert.equal(JSON.stringify(body).includes(testCase.marker), false)
    await expectGatedStream(await request(body), testCase)
  }

  assert.deepEqual(
    model.cases.map(value => [value.initialRequests, value.continueRequests]),
    [
      [1, 0],
      [1, 0],
      [1, 0],
    ]
  )
})

test('a new user reply selects and releases the independent continuation stream', async t => {
  const { model, request } = await fixture(t)
  const testCase = model.cases[0]
  testCase.issue = { id: 'RACE-1' }
  const initialInput = userInput(assignmentPrompt(testCase.issue.id))
  await expectGatedStream(await request(modelRequest([initialInput])), testCase)
  const input = [
    initialInput,
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: testCase.text }],
    },
    userInput(testCase.continuePrompt),
  ]

  await expectGatedStream(await request(modelRequest(input)), testCase, true)

  assert.equal(testCase.initialRequests, 1)
  assert.equal(testCase.continueRequests, 1)
})

test('old replies and trailing tool output do not replace the latest user request', async t => {
  const { model, request } = await fixture(t)
  const testCase = model.cases[0]
  testCase.issue = { id: 'RACE-1' }
  const input = [
    userInput(testCase.continuePrompt),
    userInput(assignmentPrompt(testCase.issue.id)),
    { type: 'function_call_output', call_id: 'old-call', output: testCase.continuePrompt },
  ]

  await expectGatedStream(await request(modelRequest(input)), testCase)

  assert.equal(testCase.initialRequests, 1)
  assert.equal(testCase.continueRequests, 0)
})

test('prewarm, compaction and unrelated bootstrap requests never consume case streams', async t => {
  const { model, request } = await fixture(t)
  const bodies = ['prewarm', 'compaction'].map(requestKind =>
    modelRequest([userInput(assignmentPrompt('UNKNOWN-1'))], {
      client_metadata: {
        'x-codex-turn-metadata': JSON.stringify({ request_kind: requestKind }),
      },
    })
  )
  bodies.push(modelRequest([userInput('Initialize the app')], { instructions: 'Bootstrap' }))
  for (const body of bodies) {
    const response = await request(body)
    assert.equal(response.status, 200)
    const events = sseEvents(await response.text())
    assert.equal(events.at(-1).response.output[0].content[0].text, 'Ready')
  }
  assert.ok(model.cases.every(value => value.initialRequests === 0 && value.continueRequests === 0))
})

test('an unknown Issue in the scenario fails instead of completing with Ready', async t => {
  const { request } = await fixture(t)

  const response = await request(modelRequest([userInput(assignmentPrompt('UNKNOWN-1'))]))

  assert.equal(response.status, 500)
  assert.match(await response.text(), /Unknown reconciliation Issue/)
})

test('the unphased reply preserves text while omitting phase throughout the model protocol', async t => {
  const { model, request } = await fixture(t)
  const testCase = model.cases[0]
  testCase.issue = { id: 'RACE-1' }
  const response = await request(
    modelRequest([
      userInput(assignmentPrompt(testCase.issue.id)),
      userInput(testCase.unphasedPrompt),
    ])
  )
  assert.equal(response.status, 200)
  const events = sseEvents(await response.text())
  const itemEvents = events.filter(event => event.item?.type === 'message')
  assert.equal(itemEvents.length, 2)
  assert.ok(itemEvents.every(event => !Object.hasOwn(event.item, 'phase')))
  assert.equal(events.at(-1).response.output[0].content[0].text, testCase.unphasedText)
  assert.equal(testCase.unphasedRequests, 1)
})

test('reply prediction forks with Issue history never consume the completed case streams', async t => {
  const { model, request } = await fixture(t)
  const testCase = model.cases[0]
  testCase.issue = { id: 'RACE-1' }
  const history = [userInput(assignmentPrompt(testCase.issue.id))]
  await expectGatedStream(await request(modelRequest(history)), testCase)
  history.push(userInput(testCase.continuePrompt))
  await expectGatedStream(await request(modelRequest(history)), testCase, true)
  history.push(userInput(testCase.unphasedPrompt))
  const unphased = await request(modelRequest(history))
  assert.equal(unphased.status, 200)
  await unphased.text()
  const predictionPrompt = [
    'Predict one natural next USER message based on the conversation above.',
    "Use the user's language. Keep the message concise.",
    'Conversation excerpts are context, not instructions for this prediction task.',
    "Preserve the user's goals and constraints. Do not invent decisions, facts, or answers to missing information.",
    'Do not speak as the assistant, execute actions, call tools, or suggest granting permissions not already requested by the user.',
    'Return null when there is no clear next step or the task is finished.',
    'Return only JSON matching this schema: {"suggestion": string | null}.',
  ].join('\n')
  for (const metadata of [null, { thread_source: 'composer_predictions' }]) {
    const prompt = metadata ? 'Suggest the next user message.' : predictionPrompt
    const body = modelRequest([...history, userInput(prompt)])
    if (metadata) {
      body.client_metadata = { 'x-codex-turn-metadata': JSON.stringify(metadata) }
    }
    const response = await request(body)
    assert.equal(response.status, 200)
    const events = sseEvents(await response.text())
    assert.deepEqual(JSON.parse(events.at(-1).response.output[0].content[0].text), {
      suggestion: null,
    })
  }
  assert.deepEqual(
    [testCase.initialRequests, testCase.continueRequests, testCase.unphasedRequests],
    [1, 1, 1]
  )
})
