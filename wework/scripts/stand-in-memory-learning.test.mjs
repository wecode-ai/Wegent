import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { loadDesktopCheckpointCatalog } from '../e2e/desktop/checkpoint-catalog.mjs'
import {
  createDesktopScenario,
  selectMemoryReviewModel,
} from '../e2e/desktop/scenarios/stand-in-memory-learning.scenario.mjs'
import { assertMemoryReviewToolBoundary } from '../e2e/desktop/modules/stand-in-memory-consolidation.mjs'

const intakeMessage = {
  role: 'user',
  content: [{ type: 'input_text', text: 'Review this silent intake batch using read_intake.' }],
}
const toolOutput = (callId, output) => ({
  type: 'function_call_output',
  call_id: callId,
  output: JSON.stringify(output),
})

async function modelResponse(scenario, input) {
  const request = Readable.from([
    JSON.stringify({
      input,
      tools: ['read_intake', 'ignore_events'].map(name => ({
        type: 'function',
        name: `mcp__wework_stand_in__${name}`,
      })),
    }),
  ])
  request.method = 'POST'
  let output
  const handled = await scenario.handleHttp(
    request,
    {
      writeHead(status) {
        assert.equal(status, 200)
      },
      end(value) {
        output = value
      },
    },
    new URL('http://model.test/v1/responses')
  )
  return {
    handled,
    items: (output ?? '')
      .split('\n')
      .filter(line => line.startsWith('data: {'))
      .map(line => JSON.parse(line.slice(6)))
      .filter(event => event.type === 'response.output_item.done')
      .map(event => event.item),
  }
}

test('memory learning resolves work-state intake through real tool requests across batches', async () => {
  const scenario = createDesktopScenario({})
  const input = [intakeMessage]
  let previousReadId
  for (const eventId of ['review-started', 'review-completed']) {
    const first = await modelResponse(scenario, input)
    assert.equal(first.handled, true)
    const [read] = first.items
    assert.equal(read.name, 'mcp__wework_stand_in__read_intake')
    assert.deepEqual(JSON.parse(read.arguments), {})
    assert.notEqual(read.call_id, previousReadId, 'A new batch cannot reuse historical outputs')
    previousReadId = read.call_id
    input.push(
      toolOutput(read.call_id, { snapshot: { events: [{ id: eventId, kind: 'work_state' }] } })
    )
    const {
      items: [ignore],
    } = await modelResponse(scenario, input)
    assert.equal(ignore.name, 'mcp__wework_stand_in__ignore_events')
    assert.deepEqual(JSON.parse(ignore.arguments).eventIds, [eventId])
    const pending = toolOutput(ignore.call_id, { status: 'pending' })
    await assert.rejects(
      () => modelResponse(scenario, [...input, toolOutput(ignore.call_id, { status: 'done' })]),
      { code: 'ERR_ASSERTION', actual: 'done', expected: 'pending' }
    )
    input.push(pending)
    const {
      items: [answer],
    } = await modelResponse(scenario, input)
    assert.equal(answer.role, 'assistant')
    input.push({ role: 'user', content: 'Review this silent intake batch: next work update.' })
  }
})

test('memory learning rejects empty intake and never defaults to ignoring other event kinds', async () => {
  for (const events of [
    [],
    [{ id: 'source-change', kind: 'connection' }],
    [
      { id: 'review', kind: 'work_state' },
      { id: 'source-change', kind: 'connection' },
    ],
  ]) {
    const scenario = createDesktopScenario({})
    const {
      items: [read],
    } = await modelResponse(scenario, [intakeMessage])
    await assert.rejects(
      () =>
        modelResponse(scenario, [
          intakeMessage,
          toolOutput(read.call_id, { snapshot: { events } }),
        ]),
      /work-state events/
    )
  }
})

test('memory learning only handles an intake request in the latest user message', async () => {
  const scenario = createDesktopScenario({})
  for (const content of ['Continue the chat.', 'Quoted: Review this silent intake batch']) {
    assert.equal(
      (await modelResponse(scenario, [intakeMessage, { role: 'user', content }])).handled,
      false
    )
  }
})

test('explicit memory review selects a non-default native model that supports high', () => {
  const model = {
    runtime: 'codex',
    provider: 'wework-e2e',
    model_id: 'gpt-6.1-sol',
    is_default: false,
    supported_reasoning_efforts: ['low', 'high', 'max'],
  }
  const unsupported = {
    ...model,
    model_id: 'gpt-5.6-sol',
    default_reasoning_effort: 'none',
    supported_reasoning_efforts: [],
  }
  assert.equal(selectMemoryReviewModel([unsupported, model]), model)
  for (const candidate of [
    unsupported,
    { ...model, is_default: true },
    { ...model, runtime: 'claude_code' },
    { ...model, provider: 'openai' },
    { ...model, supported_reasoning_efforts: undefined },
  ]) {
    assert.throws(
      () => selectMemoryReviewModel([candidate]),
      /non-default Codex model supporting high/
    )
  }
  assert.throws(() => selectMemoryReviewModel([]), /non-default Codex model supporting high/)
})

test('memory review checks top-level and incremental tool definitions', () => {
  assertMemoryReviewToolBoundary({ tools: [{ name: 'mcp__wework_stand_in__next_memory_page' }] })
  for (const tool of [
    { name: 'exec_command' },
    { function: { name: 'apply_patch' } },
    { type: 'web_search' },
    { name: 'mcp__unrelated__read' },
  ]) {
    assert.throws(() => assertMemoryReviewToolBoundary({ tools: [tool] }))
    assert.throws(() =>
      assertMemoryReviewToolBoundary({
        input: [
          {
            type: 'additional_tools',
            tools: [{ type: 'namespace', name: 'functions', tools: [tool] }],
          },
        ],
      })
    )
  }
})

test('memory learning is independently selectable and assigned to the existing core CI lane', () => {
  const catalog = loadDesktopCheckpointCatalog()
  const name = 'stand-in-memory-learning'
  assert.ok(catalog.DESKTOP_CHECKPOINTS.includes(name))
  assert.ok(catalog.SCENARIO_ONLY_CHECKPOINTS.has(name))
  assert.ok(catalog.ci.core_segments.includes(name))
  assert.equal(catalog.ci.core_shards.filter(shard => shard.split(',').includes(name)).length, 1)
  assert.equal(
    catalog.CHECKPOINT_SCENARIO_MODULES[name],
    './scenarios/stand-in-memory-learning.scenario.mjs'
  )
  const scenario = createDesktopScenario({ uiTimeoutMs: 10000, modelResponseTimeoutMs: 30000 })
  assert.equal(typeof scenario.verify, 'function')
  assert.equal(typeof scenario.handleHttp, 'function')
})
