import assert from 'node:assert/strict'
import { readMcpToolOutput } from './mcp-tool-results.mjs'
import { assertMemoryReviewToolBoundary } from './stand-in-memory-consolidation.mjs'
import {
  assistantMessage,
  mcpToolRequestEvents,
  modelMessageText,
  requestContainsToolOutput,
} from './response-protocol.mjs'

export const ORIGINAL = 'Help triage support requests.'
export const REVISED = ORIGINAL + ' Ask for the first observed occurrence before diagnosing delays.'
export const DEMONSTRATIONS = [
  [
    'alpha',
    'A build progressed after a long delay.',
    'When did the delay first happen on this build?',
  ],
  [
    'beta',
    'A download advanced one byte after ten minutes.',
    'When did you first see the download slow down?',
  ],
  ['gamma', 'The import progresses one row per minute.', 'When did imports first become slow?'],
]

/** The model proposes and compares answers; collection, evidence, and approvals run in the app. */
export function createTrainingModel() {
  const sources = new Set()
  const fitted = new Set()
  const replayed = new Map()
  const judged = new Map()
  let current
  let call
  let sequence = 0
  let reviewComplete = false
  function emit(body) {
    return mcpToolRequestEvents(body, {
      toolName: call.name,
      directToolName: 'mcp__wework_stand_in__' + call.name,
      argumentsValue: call.args,
      searchCallId: call.id + '-search',
      toolCallId: call.id,
    }).events
  }
  function next(body, name, args) {
    call = { name, args, id: 'training-evidence-' + ++sequence }
    return emit(body)
  }
  function nextSource(body) {
    const entry = sources.values().next()
    if (entry.done) {
      reviewComplete = true
      return [assistantMessage('The observed owner demonstrations are saved.')]
    }
    current = entry.value
    sources.delete(current)
    return next(body, 'next_memory_page', { taskId: current })
  }
  function review(body) {
    assertMemoryReviewToolBoundary(body)
    if (!call) return next(body, 'list_memory_sources', {})
    if (!requestContainsToolOutput(body, call.id)) return emit(body)
    const result = JSON.parse(readMcpToolOutput(body, call.id))
    assert.ok(!result.error && !result.isError, JSON.stringify(result))
    switch (call.name) {
      case 'list_memory_sources':
        for (const item of result.items)
          if (item.taskId.startsWith('training-source:')) sources.add(item.taskId)
        if (result.nextCursor) return next(body, call.name, { cursor: result.nextCursor })
        assert.equal(
          sources.size,
          DEMONSTRATIONS.length,
          'Each authorized conversation is discoverable'
        )
        return nextSource(body)
      case 'next_memory_page': {
        const messages = result.page.messages
        const demo = DEMONSTRATIONS.find(([, scene]) =>
          messages.some(message => message.content === scene)
        )
        assert.ok(demo, 'Scheduled review must read the actual connected history')
        const evidence = content => {
          const message = messages.find(item => item.content === content)
          assert.ok(message, 'Both halves of the demonstration must come from the provider page')
          return { id: message.id, excerpt: content, readArguments: result.readArguments }
        }
        return next(body, 'save_training_case', {
          taskId: current,
          kind: 'demonstration',
          content: 'Ask about onset when handling ' + demo[1],
          scene: evidence(demo[1]),
          expected: evidence(demo[2]),
        })
      }
      case 'save_training_case':
        assert.ok(result.id)
        return next(body, 'complete_memory_source', { taskId: current })
      case 'complete_memory_source':
        return nextSource(body)
      default:
        throw new Error('Unexpected training tool: ' + call.name)
    }
  }
  function offline(body, message, type) {
    assertMemoryReviewToolBoundary(body)
    const payload = JSON.parse(message.slice(message.indexOf('\n{') + 1))
    let reply
    if (type === 'propose') {
      assert.equal(payload.currentPrompt, ORIGINAL)
      assert.equal(payload.cases.length, 1)
      fitted.add(payload.cases[0].scene)
      reply = { prompt: REVISED, reason: 'The owner asks for onset before diagnosis.' }
    } else if (type === 'replay') {
      assert.deepEqual(Object.keys(payload).sort(), ['rolePrompt', 'scene'])
      assert.ok(!fitted.has(payload.scene), 'Replay must use an independent group')
      assert.ok(
        DEMONSTRATIONS.every(([, , expected]) => !JSON.stringify(body.input).includes(expected)),
        'Generating an answer must not reveal the actual owner response'
      )
      assert.ok([ORIGINAL, REVISED].includes(payload.rolePrompt))
      const prompts = replayed.get(payload.scene) ?? new Set()
      prompts.add(payload.rolePrompt)
      replayed.set(payload.scene, prompts)
      reply = {
        answer: payload.rolePrompt === REVISED ? 'When did this first occur?' : 'Please restart.',
      }
    } else {
      assert.equal(payload.kind, 'demonstration')
      assert.equal(payload.referenceAuthor, 'owner')
      assert.equal(payload.historicalAnswer, null)
      assert.ok(
        DEMONSTRATIONS.some(
          ([, scene, expected]) => scene === payload.scene && expected === payload.reference
        )
      )
      assert.notEqual(payload.A, payload.B)
      const orders = judged.get(payload.scene) ?? []
      orders.push([payload.A, payload.B])
      judged.set(payload.scene, orders)
      reply = { winner: payload.A.startsWith('When') ? 'A' : 'B', reason: 'Asks about onset.' }
    }
    return [assistantMessage(JSON.stringify(reply))]
  }
  return {
    respond(body) {
      const input =
        typeof body.input === 'string'
          ? body.input
          : modelMessageText((body.input ?? []).filter(item => item.role === 'user').at(-1))
      for (const [prefix, type] of [
        ['Propose one narrow revision', 'propose'],
        ['Replay one historical decision', 'replay'],
        ['Compare the two blinded responses', 'judge'],
      ]) {
        const pos = input.indexOf(prefix)
        if (pos >= 0) return offline(body, input.slice(pos), type)
      }
      if (JSON.stringify(body.input).includes('Consolidate useful durable memories'))
        return review(body)
      return null
    },
    verify() {
      assert.ok(reviewComplete)
      assert.equal(fitted.size, 1)
      assert.equal(judged.size, 2)
      for (const orders of judged.values()) {
        assert.equal(orders.length, 2)
        assert.deepEqual(orders[1], [orders[0][1], orders[0][0]])
      }
      assert.equal(replayed.size, 2)
      for (const prompts of replayed.values())
        assert.deepEqual(prompts, new Set([ORIGINAL, REVISED]))
    },
  }
}
