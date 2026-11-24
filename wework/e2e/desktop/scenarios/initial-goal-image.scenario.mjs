import assert from 'node:assert/strict'
import {
  assistantMessage,
  codexRequestMetadata,
  createSse,
  handleEmptyReplyPrediction,
  handleModelMaintenanceRequest,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  selectTool,
  selectedToolCall,
} from '../modules/response-protocol.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  IMAGE_ARTIFACT_BASE64,
  createSingleRootLocalProject,
  selectE2EModel,
} from '../modules/shared.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'

const GOAL = 'WEWORK_INITIAL_GOAL_IMAGE'
const DONE = 'WEWORK_INITIAL_GOAL_IMAGE_DONE'
const COMPLETE_CALL = 'initial-goal-image-complete'

export function createDesktopScenario({ workspacePath }) {
  let firstTurnId
  let finished = false
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (
        handleEmptyReplyPrediction(body, response) ||
        handleModelMaintenanceRequest(body, response)
      )
        return true
      if (!JSON.stringify(body.input ?? []).includes(GOAL)) return false

      const turnId = codexRequestMetadata(body)?.turn_id
      assert.ok(turnId, 'The native Goal model request must identify its turn')
      let id
      let output
      if (!firstTurnId) {
        const images = body.input
          .filter(item => item.role === 'user')
          .flatMap(item => item.content ?? [])
          .filter(item => item.type === 'input_image')
        assert.deepEqual(
          images.map(image => image.image_url),
          [`data:image/png;base64,${IMAGE_ARTIFACT_BASE64}`],
          'The first Goal model request must contain the submitted PNG exactly once'
        )
        firstTurnId = turnId
        id = 'initial-goal-image-first'
        output = selectedToolCall(
          COMPLETE_CALL,
          selectTool(body, 'update_goal', { status: 'complete' })
        )
      } else {
        assert.equal(turnId, firstTurnId, 'Goal creation started a second native turn')
        assert.equal(finished, false, 'A model request started after the Goal finished')
        assert.ok(requestContainsToolOutput(body, COMPLETE_CALL), 'Goal completion did not run')
        finished = true
        id = 'initial-goal-image-finished'
        output = [assistantMessage(DONE)]
      }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...output, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      await createSingleRootLocalProject(control, workspacePath, 'initial-goal-image')
      await selectE2EModel(control)
      await control.command(
        'clickWhenEnabled',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="add-context-button"]`
      )
      await control.command('clickWhenEnabled', '[data-testid="set-goal-button"]')
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: GOAL })
      await control.command('pasteFile', ACTIVE_COMPOSER_SELECTOR, {
        filename: 'goal.png',
        mimeType: 'image/png',
        value: IMAGE_ARTIFACT_BASE64,
      })
      await control.command('clickWhenEnabled', '[data-testid="send-message-button"]')
      const settled = await waitForWorkbenchDebugState(
        control,
        snapshot => {
          const lifecycle = snapshot.workbench?.activeLifecycle
          return lifecycle?.goalStatus === 'complete' && lifecycle.execution.phase === 'idle'
        },
        'The initial Goal with an image did not settle after completing in its first turn'
      )
      await control.command('waitFor', '[data-testid="message-assistant"]', { text: DONE })
      assert.equal(finished, true)
      assert.equal(settled.workbench.activeLifecycle.task.executionState.latestTurnId, firstTurnId)
    },
  }
}
