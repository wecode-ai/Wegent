import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { waitForSingleProjectByTitle } from '../modules/project-identity-flows.mjs'
import {
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  streamingTextEvents,
} from '../modules/response-protocol.mjs'
import { waitForCompletedRuntimeTaskThread } from '../modules/runtime-task-evidence.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_SEND_BUTTON_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  selectE2EModel,
} from '../modules/shared.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'

const LOCAL_PROJECT = 'Local project with a shared path'
const REMOTE_PROJECT = 'Remote project with a shared path'
const REMOTE_PROJECT_KEY = 'wegent-remote:other-device:shared-root'
const PROMPT = 'WEWORK_LOCAL_TASK_PROJECT_PATH_COLLISION'
const REPLY = 'Local project task completed'

export function createDesktopScenario({
  codexHome,
  workspacePath,
  uiTimeoutMs,
  modelResponseTimeoutMs,
}) {
  const statePath = join(codexHome, '.codex-global-state.json')
  return {
    async prepareApp() {
      // Load a saved local project and an existing remote mirror through the real executor.
      await writeFile(
        statePath,
        JSON.stringify({
          'electron-saved-workspace-roots': [workspacePath],
          'electron-workspace-root-labels': { [workspacePath]: LOCAL_PROJECT },
          'project-order': [workspacePath, REMOTE_PROJECT_KEY],
          'remote-projects': [
            {
              id: REMOTE_PROJECT_KEY,
              hostId: 'other-device',
              projectKey: 'shared-root',
              remotePath: workspacePath,
              roots: [workspacePath],
              label: REMOTE_PROJECT,
            },
          ],
        }),
        { flag: 'wx' }
      )
    },

    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      if (!JSON.stringify(body).includes(PROMPT)) return false
      const events = streamingTextEvents('local-project-task', REPLY, 'final_answer')
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([...events.start, ...events.finish]))
      return true
    },

    async verify(control) {
      const { projectId } = await waitForSingleProjectByTitle(
        control,
        LOCAL_PROJECT,
        'The saved local project was missing from the sidebar',
        uiTimeoutMs
      )
      const row = `[data-testid="project-row-${projectId}"]`
      await control.command('hover', row)
      await control.command(
        'clickWhenEnabled',
        `${row} [data-testid="project-new-conversation-button"]`
      )
      await selectE2EModel(control)
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: PROMPT })
      await control.command('clickWhenEnabled', ACTIVE_SEND_BUTTON_SELECTOR)
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
        { text: REPLY, timeoutMs: modelResponseTimeoutMs }
      )
      const { workbench } = await waitForWorkbenchDebugState(
        control,
        snapshot =>
          snapshot.workbench?.currentRuntimeTask?.taskId && !snapshot.pane?.status?.isBusy,
        'The new local project task did not finish'
      )
      const { taskId } = workbench.currentRuntimeTask
      await waitForCompletedRuntimeTaskThread(control, taskId, uiTimeoutMs)

      const taskRow = `[data-testid="runtime-local-task-row-${taskId}"]`
      const projectButton = `${row} [data-testid="project-item-button"]`
      if (
        (await control.command('getAttribute', projectButton, { value: 'aria-expanded' })) !==
        'true'
      )
        await control.command('click', projectButton)

      const readWork = async () => JSON.parse(await control.command('getLocalRuntimeWork', 'body'))
      const localFirst = work =>
        work.workspaces
          .filter(workspace => workspace.workspacePath === workspacePath)
          .map(workspace => workspace.projectKey)
          .join('\n') === [workspacePath, REMOTE_PROJECT_KEY].join('\n')
      let work = await readWork()
      if (!localFirst(work)) {
        const { projectId: remoteProjectId } = await waitForSingleProjectByTitle(
          control,
          REMOTE_PROJECT,
          'The saved remote mirror was missing from the sidebar',
          uiTimeoutMs
        )
        await control.command('drag', `[data-testid="project-drag-activator-${projectId}"]`, {
          target: `[data-testid="project-row-${remoteProjectId}"]`,
        })
        work = await waitForValue(
          readWork,
          localFirst,
          'The executor did not save the local project before the same-path remote mirror',
          uiTimeoutMs
        )
      }
      const owningWorkspace = work.workspaces.find(workspace =>
        workspace.tasks.some(task => task.taskId === taskId)
      )
      assert.equal(
        owningWorkspace?.projectKey,
        workspacePath,
        `Completed task ${taskId} must be listed under the local project when the remote mirror shares its path`
      )
      await control.command(
        'waitFor',
        `[data-testid="project-local-tasks-panel-${projectId}"] ${taskRow}`,
        { visible: true, timeoutMs: uiTimeoutMs }
      )
    },
  }
}
