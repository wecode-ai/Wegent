import assert from 'node:assert/strict'
import { isCollaborationSubagentRequest } from './subagent-request.mjs'
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

export function createIssueDelegationModel({
  marker,
  acknowledgment,
  result,
  privateEvidence,
  simple,
  answer,
  holdChild = false,
}) {
  const state = { spawned: false, childRan: false, completed: false }
  let waitId, childId
  let childResponse
  let sequence = 0
  const spawnId = `${marker}-spawn`
  const reply = (response, events) => {
    const id = `${marker}-${++sequence}`
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
  }
  return {
    state,
    releaseChild() {
      assert.ok(childResponse, 'Release the actual native worker after observing acceptance')
      reply(childResponse, [assistantMessage(privateEvidence)])
      childResponse = undefined
    },
    cleanup() {
      childResponse?.destroy()
    },
    async handleHttp(req, response, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (handleModelMaintenanceRequest(body, response)) return true
      if (isReplyPredictionRequest(body)) return false
      const input = JSON.stringify(body.input)
      if (!input.includes(marker)) return false
      if (isCollaborationSubagentRequest(req.headers)) {
        assert.equal(state.childRan, false, 'Run one real native worker')
        state.childRan = true
        if (holdChild) childResponse = response
        else reply(response, [assistantMessage(privateEvidence)])
        return true
      }
      assert.ok(
        input.includes('without requiring the user to request delegation'),
        'The real native context must allow host-directed delegation'
      )
      assert.ok(input.includes('Keep routine execution progress internal'))
      assert.ok(
        !input.includes(
          'Any earlier instruction enabling proactive multi-agent delegation no longer applies'
        ),
        'The native default restriction must not override Issue delegation'
      )
      if (simple && input.includes(simple)) {
        reply(response, [assistantMessage(answer)])
      } else if (!state.spawned) {
        state.spawned = true
        const ack = assistantMessage(acknowledgment)
        ack.item.phase = 'commentary'
        reply(response, [
          ack,
          ...selectedToolCall(
            spawnId,
            selectTool(body, 'spawn_agent', {
              task_name: 'assigned_issue_worker',
              message: `Inspect the assigned Issue ${marker} and return ${privateEvidence} to the parent. Do not publish Issue comments or perform external writes.`,
              fork_turns: 'none',
            })
          ),
        ])
      } else {
        const output = waitId && toolOutputText(body, waitId)
        const waited = output && JSON.parse(output)
        if (
          waited &&
          Object.values(waited.status).some(status => status.completed === privateEvidence)
        ) {
          assert.ok(state.childRan)
          state.completed = true
          reply(response, [assistantMessage(result)])
        } else {
          if (waited) {
            assert.ok(
              !Object.values(waited.status).some(status => status.errored || status === 'not_found')
            )
            assert.equal(waited.timed_out, true)
          }
          childId ??= JSON.parse(toolOutputText(body, spawnId)).agent_id
          assert.ok(childId, 'Use the real native child identity')
          waitId = `${marker}-wait-${++sequence}`
          reply(
            response,
            selectedToolCall(
              waitId,
              selectTool(body, 'wait_agent', {
                targets: [childId],
                timeout_ms: 60000,
              })
            )
          )
        }
      }
      return true
    },
  }
}
