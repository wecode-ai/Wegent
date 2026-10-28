import assert from 'node:assert/strict'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  createSingleRootLocalProject,
  selectE2EModel,
} from '../modules/shared.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { readMcpToolOutput } from '../modules/mcp-tool-results.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const PROMPT = 'WEWORK_E2E_SPACE_DISCOVERY: find the project spaces and inspect the target Issue.'
const PRIVATE_DESCRIPTION = 'SPACE_DISCOVERY_DESCRIPTION_FETCHED_ON_DEMAND'
const COMMENT = 'SPACE_DISCOVERY_COMMENT_PERSISTED'
const COMPLETE = 'SPACE_DISCOVERY_COMPLETE'

// A standalone personal session: only model responses are synthetic.
export function createDesktopScenario({ workspacePath, uiTimeoutMs, modelResponseTimeoutMs }) {
  let project
  let issue
  let steps
  let stepIndex = 0
  let firstRequest = true
  const assertUnbound = value => assert.equal(value.bound, false)
  const args = () => ({ space_id: project.id, item_id: issue.id })

  return {
    requiresCloudEnvironment: true,
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      assert.ok(JSON.stringify(body).includes(PROMPT))
      if (firstRequest) {
        assert.equal(JSON.stringify(body).includes(PRIVATE_DESCRIPTION), false)
      }
      const callId = () => `space-discovery-${stepIndex}`
      if (requestContainsToolOutput(body, callId())) {
        steps[stepIndex].verify(JSON.parse(readMcpToolOutput(body, callId())))
        stepIndex++
      }
      const step = steps[stepIndex]
      let events
      if (step) {
        const selection = mcpToolRequestEvents(body, {
          toolName: step.name,
          argumentsValue: step.args(),
          directToolName: `mcp__wework_space__${step.name}`,
          searchCallId: `${callId()}-search`,
          toolCallId: callId(),
        })
        if (firstRequest) {
          assert.equal(selection.mode, 'search', 'Project-space tools must be deferred')
          firstRequest = false
        }
        events = [...selection.events, responseCompleted('space-discovery')]
      } else {
        events = [assistantMessage(COMPLETE), responseCompleted('space-discovery')]
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(createSse([responseCreated('space-discovery'), ...events]))
      return true
    },
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      project = await rpc('projects.create', { name: 'On-demand project discovery' })
      issue = await rpc('todos.create', {
        project_id: project.id,
        todo: { title: 'On-demand Issue', description: PRIVATE_DESCRIPTION },
      })
      steps = [
        { name: 'get_current_context', args: () => ({}), verify: assertUnbound },
        {
          name: 'list_spaces',
          args: () => ({}),
          verify: value => assert.ok(value.some(item => item.id === project.id)),
        },
        {
          name: 'get_board_item',
          args,
          verify: value => {
            assert.equal(value.id, issue.id)
            assert.equal(value.description, PRIVATE_DESCRIPTION)
          },
        },
        {
          name: 'add_board_item_comment',
          args: () => ({ ...args(), body: COMMENT }),
          verify: value => assert.equal(value.body, COMMENT),
        },
        { name: 'get_current_context', args: () => ({}), verify: assertUnbound },
      ]
      await createSingleRootLocalProject(control, workspacePath, 'project-space-discovery')
      await selectE2EModel(control)
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: PROMPT })
      await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
        {
          text: COMPLETE,
          timeoutMs: modelResponseTimeoutMs,
        }
      )
      assert.equal(stepIndex, steps.length)
      const comments = await rpc('todos.comment.list', {
        project_id: project.id,
        task_id: issue.id,
      })
      assert.equal(comments.filter(comment => comment.body === COMMENT).length, 1)
      // The checkpoint runner discards its isolated Executor home and workspace.
    },
  }
}
