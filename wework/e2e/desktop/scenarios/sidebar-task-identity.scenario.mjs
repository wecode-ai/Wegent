import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  createSingleRootLocalProject,
  selectE2EModel,
} from '../modules/shared.mjs'
import { createSse, readRequestBody, streamingTextEvents } from '../modules/response-protocol.mjs'
import { runtimeTransportGates } from '../modules/runtime-transport-gates.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'
import { waitForCompletedRuntimeTaskThread } from '../modules/runtime-task-evidence.mjs'

const PROMPT = 'WEWORK_SIDEBAR_TASK_IDENTITY'
const ANSWER = `${PROMPT}_COMPLETE`
const SIDEBAR = '[data-testid="sidebar-worklists-scroll"]'

export function createDesktopScenario({ workspacePath, resultDir, uiTimeoutMs }) {
  let releaseModel
  const modelHeld = new Promise(resolve => {
    releaseModel = resolve
  })
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (!JSON.stringify(body).includes(PROMPT)) return false
      const events = streamingTextEvents('sidebar-task-identity', ANSWER, 'final_answer')
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(createSse(events.start))
      await modelHeld
      response.end(createSse(events.finish))
      return true
    },
    async verify(control) {
      const gates = runtimeTransportGates(control)
      const creation = 'sidebar-task-create-response'
      const refresh = 'sidebar-task-post-create-refresh'
      try {
        await createSingleRootLocalProject(control, workspacePath, 'Sidebar task identity')
        await selectE2EModel(control)
        await control.command('click', '[data-testid="execution-mode-button"]')
        await control.command(
          'clickWhenEnabled',
          '[data-testid="execution-mode-git-worktree-button"]'
        )
        await gates.arm({ id: creation, kind: 'response', name: 'runtime.tasks.create' })
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: PROMPT })
        await control.command(
          'clickWhenEnabled',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
        )
        const captured = await gates.wait(creation)
        const address = captured.value.result
        assert.equal(address.accepted, true, 'The real executor rejected task creation')
        assert.ok(address.taskId)
        assert.ok(address.workspacePath, 'The create response must expose its prepared worktree')
        assert.notEqual(address.workspacePath, workspacePath)
        const row = `${SIDEBAR} [data-testid="runtime-local-task-row-${address.taskId}"]`
        await control.command('refreshRuntimeWork', 'body', { value: JSON.stringify(address) })
        await control.command('waitFor', row)
        assert.equal(Number(await control.command('getElementCount', row)), 1)
        const ownerWork = JSON.parse(await control.command('getLocalRuntimeWork', 'body'))
        const ownerWorkspace = ownerWork.workspaces.find(workspace =>
          workspace.tasks.some(task => task.taskId === address.taskId)
        )
        assert.ok(ownerWorkspace, 'The real executor did not list the created task')
        assert.notEqual(
          ownerWorkspace.workspacePath,
          address.workspacePath,
          'The fixture must distinguish project grouping from the execution worktree'
        )
        // Prevent a later list refresh from concealing the duplicate added by creation.
        await gates.arm({
          id: refresh,
          kind: 'request',
          name: 'runtime.tasks.list',
          holdFollowing: true,
        })
        await gates.release(creation)
        const debug = await waitForWorkbenchDebugState(
          control,
          state => state.workbench?.currentRuntimeTask?.workspacePath === address.workspacePath,
          'The accepted create response did not reconcile the selected task',
          uiTimeoutMs
        )
        const rowCount = Number(await control.command('getElementCount', row))
        await gates.save(resultDir, 'sidebar-task-identity-transport.json', [creation, refresh])
        await writeFile(
          join(resultDir, 'sidebar-task-identity.json'),
          JSON.stringify({ address, ownerWorkspace, rowCount, debug }, null, 2)
        )
        assert.equal(rowCount, 1, 'The late create response duplicated the sidebar task')
        await gates.reset()
        releaseModel()
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
          {
            text: ANSWER,
          }
        )
        await waitForCompletedRuntimeTaskThread(control, address.taskId, uiTimeoutMs)
        const completedRefresh = 'sidebar-task-completed-refresh'
        await gates.arm({
          id: completedRefresh,
          kind: 'response',
          name: 'runtime.tasks.list',
          where: [{ path: 'result.workspaces.*.tasks.*.taskId', equals: address.taskId }],
          hold: false,
        })
        await control.command('refreshRuntimeWork', 'body', { value: JSON.stringify(address) })
        await gates.wait(completedRefresh)
        await control.command('waitFor', row)
        assert.equal(Number(await control.command('getElementCount', row)), 1)
      } finally {
        releaseModel()
        await gates.reset()
      }
    },
  }
}
