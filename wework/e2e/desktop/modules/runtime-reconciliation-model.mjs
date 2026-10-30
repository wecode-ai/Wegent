import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import {
  assistantMessage,
  codexRequestKind,
  createSse,
  latestModelInputText,
  readRequestBody,
  responseCompleted,
  responseCreated,
  streamingTextEvents,
} from './response-protocol.mjs'

function deferred() {
  let resolve
  const promise = new Promise(done => {
    resolve = done
  })
  return { promise, resolve }
}

function modelCase(marker, order) {
  marker = `${marker}_${order}`
  const prefix = `${marker}_PARTIAL`
  const tail = ` Final output is complete: ${'0123456789 abcdefghijklmnopqrstuvwxyz '.repeat(48)}${marker}_END`
  return {
    order,
    marker,
    prefix,
    tail,
    text: prefix + tail,
    continuePrompt: `${marker}_CONTINUE`,
    continuePrefix: `${marker}_NEW_TURN_RUNNING`,
    continueText: `${marker}_NEW_TURN_RUNNING ${marker}_NEW_TURN_COMPLETE`,
    unphasedPrompt: `${marker}_UNPHASED_REPLY`,
    unphasedText: `${marker}_UNPHASED_FINAL_ANSWER`,
    initialGate: deferred(),
    continueGate: deferred(),
    initialRequests: 0,
    continueRequests: 0,
    unphasedRequests: 0,
  }
}

function identifiesIssue(body, issueId) {
  const escaped = issueId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\w-])${escaped}($|[^\\w-])`).test(body)
}

function latestUserInput(body) {
  const messages = Array.isArray(body.input) ? body.input : body.messages
  const user = Array.isArray(messages) ? messages.findLast(item => item.role === 'user') : null
  return user ? JSON.stringify(user) : latestModelInputText(body)
}

function streamDelta(stream, delta) {
  return {
    type: 'response.output_text.delta',
    item_id: stream.itemId,
    output_index: 0,
    content_index: 0,
    delta,
  }
}

export function createRuntimeReconciliationModel({ marker, orders }) {
  const cases = orders.map(order => modelCase(marker, order))
  return {
    cases,
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      const serialized = JSON.stringify(body)
      const testCase = cases.find(
        candidate => candidate.issue && identifiesIssue(serialized, candidate.issue.id)
      )
      const id = `${marker}-${randomUUID()}`
      const background = ['prewarm', 'compaction'].includes(codexRequestKind(body))
      if (background || !testCase) {
        assert.ok(
          background || !serialized.includes(marker),
          'Unknown reconciliation Issue in a model request'
        )
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.end(
          createSse([responseCreated(id), assistantMessage('Ready'), responseCompleted(id)])
        )
        return true
      }
      const latestInput = latestUserInput(body)
      if (latestInput.includes(testCase.unphasedPrompt)) {
        testCase.unphasedRequests += 1
        assert.equal(testCase.unphasedRequests, 1, 'The unphased reply invoked its model twice')
        const stream = streamingTextEvents(id, testCase.unphasedText)
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.end(
          createSse([...stream.start, streamDelta(stream, testCase.unphasedText), ...stream.finish])
        )
        return true
      }
      const continuation = latestInput.includes(testCase.continuePrompt)
      const counter = continuation ? 'continueRequests' : 'initialRequests'
      testCase[counter] += 1
      assert.equal(testCase[counter], 1, 'A reconciliation case invoked its model more than once')
      const text = continuation ? testCase.continueText : testCase.text
      const prefix = continuation ? testCase.continuePrefix : testCase.prefix
      const stream = streamingTextEvents(id, text, 'final_answer')
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.write(createSse([...stream.start, streamDelta(stream, prefix)]))
      await (continuation ? testCase.continueGate : testCase.initialGate).promise
      response.end(createSse([streamDelta(stream, text.slice(prefix.length)), ...stream.finish]))
      return true
    },
    release() {
      cases.forEach(testCase => {
        testCase.initialGate.resolve()
        testCase.continueGate.resolve()
      })
    },
    diagnostics: () =>
      cases.map(testCase => ({
        order: testCase.order,
        issueId: testCase.issue?.id,
        initialRequests: testCase.initialRequests,
        continueRequests: testCase.continueRequests,
        unphasedRequests: testCase.unphasedRequests,
      })),
  }
}
