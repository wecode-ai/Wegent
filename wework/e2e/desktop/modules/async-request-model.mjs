import assert from 'node:assert/strict'
import { selectedToolCall } from './model-tool-calls.mjs'
import {
  assistantMessage,
  createSse,
  handleModelMaintenanceRequest,
  isReplyPredictionRequest,
  readRequestBody,
  responseCompleted,
  responseCreated,
  selectTool,
  toolOutputText,
} from './response-protocol.mjs'

/** Only model responses are scripted; writes run through the native apply_patch tool. */
export function createAsyncRequestModel(marker, file, beforeWrite) {
  const held = new Map()
  const released = new Set()
  const state = { patched: [], waiting: [], released: [] }
  let sequence = 0
  const message = letter => `${marker}: independent request ${letter}`
  const proof = letter => `${marker}_${letter}_PRIVATE_FILE\n`
  const reply = (response, events) => {
    const id = `${marker}-${++sequence}`
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
  }
  return {
    state,
    message,
    proof,
    release(letter) {
      const response = held.get(letter)
      assert.ok(response, `Release ${letter} only after its real native write has finished`)
      released.add(letter)
      state.released.push(letter)
      held.delete(letter)
      reply(response, [assistantMessage(`${marker}: finished ${letter}`)])
    },
    cleanup() {
      for (const response of held.values()) response.destroy()
      held.clear()
    },
    async handleHttp(req, response, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (handleModelMaintenanceRequest(body, response)) return true
      if (isReplyPredictionRequest(body)) return false
      const input = JSON.stringify(body.input)
      if (!input.includes(marker)) return false
      const letter = ['B', 'A'].find(letter => input.includes(message(letter)))
      if (!letter || released.has(letter)) {
        reply(response, [assistantMessage(`${marker}: finished ${letter ?? 'setup'}`)])
        return true
      }
      const call = `${marker}-write-${letter}`
      if (toolOutputText(body, call) === null) {
        assert.ok(!state.patched.includes(letter), 'Retries must reuse the native tool result')
        await beforeWrite?.(letter)
        state.patched.push(letter)
        const patch = `*** Begin Patch\n*** Add File: ${file}\n+${proof(letter).trimEnd()}\n*** End Patch`
        reply(response, selectedToolCall(call, selectTool(body, 'apply_patch', patch)))
      } else {
        assert.ok(!held.has(letter), 'One active model continuation belongs to each request')
        held.set(letter, response)
        state.waiting.push(letter)
      }
      return true
    },
  }
}
