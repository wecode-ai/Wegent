import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { createLocalCollaborationProject } from '../modules/workspace-flows.mjs'
import { selectE2EModel } from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  isReplyPredictionRequest,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const PROJECT = `看板直接会话-${process.pid}`
const REQUEST = 'PROJECT_SIDEBAR_CONTEXT_CHECK'
const RESULT = 'PROJECT_SIDEBAR_LOCAL_REPLY'
const FOLLOW_UP = 'PROJECT_SIDEBAR_CONTINUE_CHECK'
const CONTINUED = 'PROJECT_SIDEBAR_CONTINUED_REPLY'
const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const CHAT = `${CONTENT} [data-testid="project-space-chat-panel"]`

/** Real project storage and local Runtime; only the model response is synthetic. */
export function createDesktopScenario({ uiTimeoutMs, modelResponseTimeoutMs }) {
  let modelTurns = 0
  return {
    async handleHttp(req, response, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (isReplyPredictionRequest(body)) return false
      const input = JSON.stringify(body.input ?? [])
      if (!input.includes(REQUEST) && !input.includes(FOLLOW_UP)) return false
      if (!modelTurns) {
        assert.ok(
          JSON.stringify(body).includes(PROJECT),
          'The local project must be supplied as context'
        )
      }
      const id = `project-sidebar-chat-${++modelTurns}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(id),
          assistantMessage(input.includes(FOLLOW_UP) ? CONTINUED : RESULT),
          responseCompleted(id),
        ])
      )
      return true
    },
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await createLocalCollaborationProject(control, CONTENT, PROJECT)
      const project = (await rpc('projects.list', {})).find(row => row.name === PROJECT)
      assert.ok(project)
      assert.equal(project.metadata?.collaboration_groups?.length ?? 0, 0)
      const open = `${CONTENT} [data-testid="project-space-chat-open"]`
      await control.command('clickWhenEnabled', open)
      await control.command('waitFor', CHAT)
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            `${CONTENT} [data-testid="project-space-chat-runtime-project"]`
          )
        ),
        0
      )
      await selectE2EModel(control, undefined, undefined, CHAT)
      await control.command('fill', `${CHAT} [data-testid="chat-message-input"]`, {
        value: REQUEST,
      })
      await control.command('clickWhenEnabled', `${CHAT} [data-testid="send-message-button"]`)
      await control.command('waitFor', CHAT, { text: RESULT, timeoutMs: modelResponseTimeoutMs })
      const conversations = async () => {
        const listed = await rpc('runtime.tasks.list', {})
        return listed.workspaces
          .flatMap(workspace => workspace.tasks)
          .filter(
            task =>
              task.runtimeHandle?.origin?.type === 'project_chat' &&
              task.runtimeHandle.origin.cloudProjectId === project.id
          )
      }
      const tasks = await conversations()
      assert.equal(tasks.length, 1, 'Sending creates exactly one persistent local conversation')
      assert.equal(tasks[0].runtimeHandle.origin.projectStore, 'local')
      await control.command('click', `${CONTENT} [data-testid="project-space-chat-close"]`)
      await control.command('waitFor', `${CONTENT} [data-testid="project-space-chat-sidebar"]`, {
        visible: false,
      })
      await control.command('clickWhenEnabled', open)
      await control.command('waitFor', CHAT)
      await control.command('click', `${CONTENT} [data-testid="project-space-chat-menu"]`)
      await control.command('click', `${CONTENT} [data-testid="project-space-chat-menu-item"]`)
      await control.command('waitFor', CHAT, { text: RESULT })
      await control.command('fill', `${CHAT} [data-testid="chat-message-input"]`, {
        value: FOLLOW_UP,
      })
      await control.command('clickWhenEnabled', `${CHAT} [data-testid="send-message-button"]`)
      await control.command('waitFor', CHAT, { text: CONTINUED, timeoutMs: modelResponseTimeoutMs })
      assert.equal(
        (await conversations()).length,
        1,
        'Reopening continues the original conversation'
      )
      assert.ok(modelTurns >= 2)
      await control.command('click', `${CONTENT} [data-testid="project-space-chat-close"]`)
      return { projectId: project.id, taskId: tasks[0].taskId, modelTurns }
    },
  }
}
