import assert from 'node:assert/strict'
import { createDesktopScenario as createCapabilityScenario } from './collaboration-local-agent-capabilities.scenario.mjs'
import {
  requestContainsToolOutput,
  namespacedFunctionCall,
  requestToolSearchResults,
  selectToolSearch,
  toolSearchResponseEvents,
} from '../modules/response-protocol.mjs'

// Expectations are deliberately independent of the production authorization table.
const MANAGEMENT_TOOLS = [
  'get_assignment_candidates',
  'submit_workflow_plan',
  'decide_workflow_review',
  'assign_board_item',
  'update_board_item',
]
const EXECUTION_TOOLS = [
  'get_current_context',
  'get_board_item',
  'list_item_attachments',
  'upload_item_attachment',
  'report_workflow_outcome',
]

function searchedNames(body) {
  return requestToolSearchResults(body).flatMap(tool =>
    tool.type === 'namespace' && tool.name === 'wework_space'
      ? (tool.tools ?? []).map(tool => tool.name)
      : [tool.name ?? tool.function?.name].filter(Boolean).map(name => name.split('__').at(-1))
  )
}

export async function createDesktopScenario(options) {
  const completed = new Set()
  let reviewPersisted = false
  const scenario = await createCapabilityScenario({
    ...options,
    inspectModelRequest(body, { boundContext }) {
      const serialized = JSON.stringify(
        (body.input ?? body.messages ?? []).filter(item => item.role === 'user')
      )
      const role = serialized.includes('Review the executor results')
        ? 'review-manager'
        : serialized.includes('LOCAL_MANAGER_GENERATED_EXECUTOR_PROMPT:')
          ? 'executor'
          : 'planning-manager'
      const expectations = [
        ...EXECUTION_TOOLS.map(name => [name, true]),
        ...MANAGEMENT_TOOLS.map(name => [name, role !== 'executor']),
      ]
      for (const [name, allowed] of expectations) {
        const callId = `role-contract-${role}-${name}`
        if (completed.has(callId)) continue
        if (!requestContainsToolOutput(body, callId)) {
          return toolSearchResponseEvents(callId, selectToolSearch(body, `wework_space ${name}`))
        }
        assert.equal(
          searchedNames(body).includes(name),
          allowed,
          `${role}: ${name} must be ${allowed ? 'available' : 'excluded'} by tool category`
        )
        completed.add(callId)
      }
      if (role === 'executor') {
        const deniedCall = 'executor-forbidden-status-change'
        if (!requestContainsToolOutput(body, deniedCall)) {
          return namespacedFunctionCall(deniedCall, 'wework_space', 'update_board_item', {
            space_id: boundContext.space_id,
            item_id: boundContext.item_id,
            item: { status: 'completed' },
          })
        }
        const forbiddenOutput = (body.input ?? []).find(
          item => item.call_id === deniedCall && item.type.endsWith('_output')
        )
        const forbiddenOutputText = JSON.stringify(forbiddenOutput)
        assert.match(
          forbiddenOutputText,
          /not allowed|cannot|unknown|not found|not available|unrecognized|unsupported call/i,
          `An executor was able to call a management tool: ${forbiddenOutputText}`
        )
        const outcomeCall = 'executor-report-outcome'
        if (!requestContainsToolOutput(body, outcomeCall)) {
          const args = {
            space_id: boundContext.space_id,
            item_id: boundContext.item_id,
            verdict: 'passed',
            summary: 'The real local executor verified its configured capability.',
          }
          const names = searchedNames(body)
          assert.ok(names.includes('report_workflow_outcome'))
          return namespacedFunctionCall(
            outcomeCall,
            'wework_space',
            'report_workflow_outcome',
            args
          )
        }
        const outcome = (body.input ?? []).find(
          item => item.call_id === outcomeCall && item.type.endsWith('_output')
        )
        assert.match(JSON.stringify(outcome), /passed/, 'The local outcome was not persisted')
      }
      if (requestContainsToolOutput(body, 'local-manager-review-call')) {
        const output = JSON.stringify(body.input ?? body.messages)
        assert.match(output, /completed/, 'Review tool did not return a completed decision')
        assert.doesNotMatch(output, /This orchestration operation requires a backend project space/)
        reviewPersisted = true
      }
      return null
    },
  })
  return {
    ...scenario,
    async verify(control) {
      await scenario.verify(control)
      await control.command('waitFor', '[data-testid^="cloud-task-manager-event-"]', {
        text: '验收通过，完成 Issue',
        timeoutMs: options.modelResponseTimeoutMs,
      })
      assert.ok(reviewPersisted, 'Manager review never persisted its decision')
      for (const role of ['planning-manager', 'executor', 'review-manager']) {
        for (const name of [...EXECUTION_TOOLS, ...MANAGEMENT_TOOLS]) {
          assert.ok(
            completed.has(`role-contract-${role}-${name}`),
            `${role}: ${name} was not verified`
          )
        }
      }
    },
  }
}
