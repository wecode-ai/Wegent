import assert from 'node:assert/strict'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  CLOUD_PUBLIC_MODEL_NAME,
  createSingleRootLocalProject,
  fetchJson,
  selectE2EModel,
} from '../modules/shared.mjs'
import { waitForSnapshot } from '../modules/conversation-layout.mjs'
import { reloadMainWindow } from '../modules/workspace-flows.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const MARKER = 'WEWORK_TASK_MODEL_DELETION'
const SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="model-selector-button"]`
const SEND = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`

export function createDesktopScenario({ workspacePath, modelResponseTimeoutMs }) {
  let cloud
  let deletedModelId
  let replyCount = 0
  const modelName = `task-model-deletion-${process.pid}`
  const request = (path, options = {}) =>
    fetchJson(`${cloud.backendUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${cloud.authToken}`,
        'Content-Type': 'application/json',
      },
    })

  async function send(control, suffix) {
    const expectedReply = replyCount + 1
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: `${MARKER} ${suffix}` })
    await control.command('clickWhenEnabled', SEND)
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
      {
        text: `${MARKER} reply ${expectedReply}`,
        timeoutMs: modelResponseTimeoutMs,
      }
    )
    await control.command('waitFor', SEND)
  }

  async function assertRecoveryEntry(control) {
    await control.command('waitFor', SELECTOR, { visible: true })
    assert.ok((await control.command('getText', SELECTOR)).trim(), 'Model selector label is empty')
    assert.equal(Number(await control.command('getElementCount', `${SELECTOR}:disabled`)), 0)
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: `${MARKER} unsent draft` })
    assert.equal(Number(await control.command('getElementCount', `${SEND}:disabled`)), 1)
    await control.command('click', SELECTOR)
    await control.command('waitFor', '[data-testid="model-selector-menu"]', { visible: true })
    await control.command('press', 'body', { key: 'Escape' })
  }

  return {
    requiresCloudEnvironment: true,
    async prepareCloud(environment) {
      cloud = environment
      await request('/api/admin/setup-complete', { method: 'POST' })
    },
    setCloudEnvironment(environment) {
      cloud = environment
    },
    async handleHttp(httpRequest, response, url) {
      if (httpRequest.method !== 'POST' || !['/v1/responses', '/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(httpRequest)
      if (!JSON.stringify(body).includes(MARKER)) return false
      const id = `task-model-deletion-${++replyCount}`
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(id),
          assistantMessage(`${MARKER} reply ${replyCount}`),
          responseCompleted(id),
        ])
      )
      return true
    },
    async verify(control) {
      try {
        const created = await request('/api/models/batch', {
          method: 'POST',
          body: JSON.stringify([
            {
              name: modelName,
              env: {
                model: 'openai',
                model_id: modelName,
                base_url: `${cloud.modelServerUrl}/v1`,
                api_key: 'desktop-e2e',
              },
              is_active: true,
              wework_available: true,
              protocol: 'openai-responses',
              api_format: 'responses',
            },
          ]),
        })
        deletedModelId = created.created[0]?.id
        assert.ok(deletedModelId, 'The deletion fixture was not persisted')
        await createSingleRootLocalProject(control, workspacePath, 'Task model deletion')
        await selectE2EModel(control, 'local-model:desktop-e2e-responses', 'Desktop E2E Responses')
        await send(control, 'initial local model')
        const snapshot = await waitForSnapshot(
          control,
          state => state.testIds.some(id => id.startsWith('runtime-local-task-row-')),
          'The local task was not created'
        )
        const row = snapshot.testIds.find(id => id.startsWith('runtime-local-task-row-'))
        const taskSelector = `[data-testid="${row}"]`

        // Delete the local configuration through the actual settings UI and reopen the task.
        await control.command('navigate', 'body', { value: '/settings/personal/models' })
        await control.command('waitFor', '[data-testid="local-model-delete-desktop-e2e-responses"]')
        await control.command('click', '[data-testid="local-model-delete-desktop-e2e-responses"]')
        await control.command('navigate', 'body', { value: '/' })
        await control.command('click', taskSelector)
        await assertRecoveryEntry(control)
        await selectE2EModel(control, modelName, modelName)
        await send(control, 'replacement cloud model')

        // A cold renderer must also recover when the persisted cloud model has been deleted.
        await request(`/api/models/${deletedModelId}`, { method: 'DELETE' })
        deletedModelId = null
        await reloadMainWindow(control, 'The renderer did not reconnect after cloud model deletion')
        await control.command('waitFor', taskSelector)
        await control.command('click', taskSelector)
        await assertRecoveryEntry(control)
        await selectE2EModel(control, CLOUD_PUBLIC_MODEL_NAME, CLOUD_PUBLIC_MODEL_NAME)
        await send(control, 'follow-up after cloud deletion')
        assert.equal(replyCount, 3, 'Recovery did not continue the existing task')
      } finally {
        if (deletedModelId) await request(`/api/models/${deletedModelId}`, { method: 'DELETE' })
      }
    },
  }
}
