import { fetchLocalRuntimeJson } from '../modules/runtime-request.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { until } from '../modules/plugin-regression-fixture.mjs'
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
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const MARKER = 'WEWORK_TASK_MODEL_DELETION'
const SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="model-selector-button"]`
const SEND = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`

export function createDesktopScenario({ workspacePath, modelResponseTimeoutMs, resultDir }) {
  let cloud
  let deletedModelId
  let offlineModelId
  let replyCount = 0
  const modelName = `task-model-deletion-${process.pid}`
  const localModelName = `local-deletion-${process.pid}`
  const offlineModelName = `task-model-offline-${process.pid}`
  const request = (path, options = {}) =>
    fetchJson(`${cloud.backendUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${cloud.authToken}`,
        'Content-Type': 'application/json',
      },
    })

  async function deletePublicModel(modelId) {
    // The admin delete endpoint answers 204 with no JSON body.
    const response = await fetch(`${cloud.backendUrl}/api/admin/public-models/${modelId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${cloud.authToken}` },
    })
    assert.equal(response.status, 204, 'Offline fixture cleanup must return 204')
  }

  async function createLocalModel(control) {
    await control.command('navigate', 'body', { value: '/settings/personal/models' })
    await control.command('waitFor', '[data-testid="provider-add"]')
    await control.command('click', '[data-testid="provider-add"]')
    await control.command('waitFor', '[data-testid="provider-editor"]')
    await control.command('select', '[data-testid="provider-preset"]', { value: 'custom' })
    await control.command('fill', '[data-testid="provider-name"]', { value: modelName })
    await control.command('fill', '[data-testid="provider-base-url"]', {
      value: cloud.modelServerUrl,
    })
    await control.command('fill', '[data-testid="provider-api-key"]', { value: 'desktop-e2e' })
    await control.command('click', '[data-testid="provider-model-add"]')
    const editor = JSON.parse(await control.command('snapshot', '[data-testid="provider-editor"]'))
    const input = editor.testIds.find(id => id.startsWith('provider-model-id-'))
    assert.ok(input, 'The local deletion fixture editor is unavailable')
    const id = input.slice('provider-model-id-'.length)
    await control.command('fill', `[data-testid="${input}"]`, { value: localModelName })
    await control.command('click', '[data-testid="provider-editor-save"]')
    await control.command('waitFor', '[data-testid="provider-editor"]', { visible: false })
    await control.command(
      'waitFor',
      `[data-testid^="provider-row-"]:has([data-testid="provider-model-${id}"])`
    )
    assert.equal(
      Number(await control.command('getElementCount', `[data-testid="provider-model-${id}"]`)),
      1,
      'The local deletion fixture was not persisted'
    )
    return id
  }

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
    // Cold task hydration can temporarily replace Send with Pause.
    await control.command('waitFor', SEND, { visible: true })
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: `${MARKER} unsent draft` })
    assert.equal(Number(await control.command('getElementCount', `${SEND}:disabled`)), 1)
    await control.command('click', SELECTOR)
    await control.command('waitFor', '[data-testid="model-selector-menu"]', { visible: true })
    await control.command('press', 'body', { key: 'Escape' })
  }

  async function conversationIdentity(control) {
    const state = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    const address = state.workbench?.currentRuntimeTask
    const origin = await control.command('getLocationOrigin', 'body')
    const response = await fetchLocalRuntimeJson(control, `${origin}/wework/executor/v1/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'model-deletion-task',
        method: 'runtime.tasks.get',
        params: { address },
      }),
      timeoutMs: modelResponseTimeoutMs,
    })
    assert.equal(response.ok, true, 'The persisted task could not be read')
    const task = response.result?.task
    assert.ok(task?.taskId && task?.threadId, 'The task conversation identity is unavailable')
    assert.equal(task.taskId, address?.taskId, 'The active task does not match the persisted task')
    return { taskId: task.taskId, threadId: task.threadId }
  }

  async function assertOriginalConversation(control, identity, row) {
    assert.deepEqual(
      await conversationIdentity(control),
      identity,
      'Model replacement changed the original task or conversation'
    )
    const state = JSON.parse(await control.command('snapshot', 'body'))
    assert.deepEqual(
      state.testIds.filter(id => id.startsWith('runtime-local-task-row-')),
      [row],
      'Model replacement created another task instead of continuing the original task'
    )
  }

  /** Inspect the real feedback preview for the owning task's allowlisted model identities. */
  async function assertFeedbackModelSnapshot(control, identity, expectedModelName) {
    await control.command('clickWhenEnabled', '[data-testid="topnav-feedback-button"]')
    try {
      await control.command('waitFor', '[data-testid="task-feedback-note"]', { visible: true })
      await control.command('fill', '[data-testid="task-feedback-note"]', {
        value: 'Inspect the saved and restored task model identities.',
      })
      await control.command(
        'clickWhenEnabled',
        '[data-testid="task-feedback-group-full-task-checkbox"]'
      )
      await control.command('clickWhenEnabled', '[data-testid="task-feedback-export-button"]')
      await control.command('waitFor', '[data-testid="task-feedback-preview-list"]')
      await control.command(
        'clickWhenEnabled',
        '[data-testid="task-feedback-preview-category-task"]'
      )
      await control.command(
        'clickWhenEnabled',
        '[data-testid="task-feedback-preview-entry-context/task.json"]'
      )
      await control.command('waitFor', '[data-testid="task-feedback-preview-content"]')
      const context = JSON.parse(
        await control.command('getText', '[data-testid="task-feedback-preview-content"]')
      )
      assert.equal(context.task.taskId, identity.taskId)
      assert.equal(typeof context.modelSelection?.scopeFingerprint, 'number')
      for (const source of ['configured', 'effective', 'selected']) {
        assert.equal(
          context.modelSelection[source]?.modelName,
          expectedModelName,
          `The feedback preview omitted the ${source} task model identity`
        )
        assert.equal(Object.hasOwn(context.modelSelection[source], 'options'), false)
      }
    } finally {
      await control.command('clickWhenEnabled', '[data-testid="task-feedback-close-button"]')
      await control.command('waitFor', '[data-testid="task-feedback-dialog-overlay"]', {
        visible: false,
      })
    }
  }

  /** Check that actual task and transcript reads log the owning task's saved model identity. */
  async function assertTaskReadModelDiagnostics(control, identity, expectedModelName) {
    const address = { taskId: identity.taskId }
    const saved = await requestExecutor(control, 'runtime.tasks.get', { address })
    const selection = saved.task.runtimeHandle.modelSelection
    assert.equal(selection.modelName, expectedModelName)
    await requestExecutor(control, 'runtime.tasks.transcript', { address })
    const events = ['runtime task get resolved link', 'runtime task transcript resolved link']
    await until(
      () => readFile(join(resultDir, 'executor.log'), 'utf8'),
      log =>
        events.every(event =>
          log
            .split('\n')
            .some(
              line =>
                line.includes(event) &&
                line.includes(`local_task_id=${identity.taskId} `) &&
                line.includes(`model_selection_name=${expectedModelName} `) &&
                line.includes(`model_selection_type=${selection.modelType}`)
            )
        ),
      'Task reads did not log the saved model identity'
    )
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
      if (handleEmptyReplyPrediction(body, response)) return true
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
        const localModelId = await createLocalModel(control)
        await control.command('navigate', 'body', { value: '/' })
        await createSingleRootLocalProject(control, workspacePath, 'Task model deletion')
        await selectE2EModel(control, `local-model:${localModelId}`, localModelName)
        await send(control, 'initial local model')
        const snapshot = await waitForSnapshot(
          control,
          state => state.testIds.some(id => id.startsWith('runtime-local-task-row-')),
          'The local task was not created'
        )
        const row = snapshot.testIds.find(id => id.startsWith('runtime-local-task-row-'))
        const taskSelector = `[data-testid="${row}"]`
        const identity = await conversationIdentity(control)
        await assertFeedbackModelSnapshot(control, identity, `local-model:${localModelId}`)
        await assertTaskReadModelDiagnostics(control, identity, `local-model:${localModelId}`)

        // Delete the local configuration through the actual settings UI and reopen the task.
        await control.command('navigate', 'body', { value: '/settings/personal/models' })
        const model = `[data-testid="provider-model-${localModelId}"]`
        const provider = `[data-testid^="provider-row-"]:has(${model})`
        await control.command('waitFor', provider)
        await control.command('click', `${provider} > summary`)
        await control.command('click', `[data-testid="provider-model-edit-${localModelId}"]`)
        await control.command('waitFor', '[data-testid="provider-editor"]')
        await control.command('click', `[data-testid="provider-model-remove-${localModelId}"]`)
        await control.command('click', '[data-testid="provider-editor-save"]')
        await control.command('waitFor', '[data-testid="provider-editor"]', { visible: false })
        assert.equal(Number(await control.command('getElementCount', model)), 0)
        await control.command('navigate', 'body', { value: '/' })
        await control.command('waitFor', taskSelector)
        await control.command('click', taskSelector)
        await assertRecoveryEntry(control)
        await selectE2EModel(control, modelName, modelName)
        await send(control, 'replacement cloud model')
        await assertOriginalConversation(control, identity, row)

        // A cold renderer must also recover when the persisted cloud model has been deleted.
        await request(`/api/models/${deletedModelId}`, { method: 'DELETE' })
        deletedModelId = null
        await reloadMainWindow(control, 'The renderer did not reconnect after cloud model deletion')
        await control.command('waitFor', taskSelector)
        await control.command('click', taskSelector)
        await assertRecoveryEntry(control)
        const catalog = await request(
          '/api/models/unified?include_config=true&scope=all&model_category_type=llm&client_origin=wework'
        )
        const replacement = catalog.data.find(model => model.name === CLOUD_PUBLIC_MODEL_NAME)
        assert.ok(replacement, 'The replacement cloud model is unavailable')
        await selectE2EModel(
          control,
          replacement.name,
          replacement.displayName || replacement.modelId || replacement.name
        )
        await send(control, 'follow-up after cloud deletion')
        assert.equal(replyCount, 3, 'Recovery did not continue the existing task')
        await assertOriginalConversation(control, identity, row)

        // Hiding a public model after it has served the task must not replace
        // the saved selection: the same task keeps calling it.
        const offline = await request('/api/admin/public-models', {
          method: 'POST',
          body: JSON.stringify({
            name: offlineModelName,
            namespace: 'default',
            json: {
              apiVersion: 'agent.wecode.io/v1',
              kind: 'Model',
              metadata: {
                name: offlineModelName,
                namespace: 'default',
                displayName: offlineModelName,
              },
              spec: {
                protocol: 'openai-responses',
                apiFormat: 'responses',
                modelType: 'llm',
                isVisible: true,
                isWeworkAvailable: true,
                modelConfig: {
                  env: {
                    model: 'openai',
                    model_id: offlineModelName,
                    base_url: `${cloud.modelServerUrl}/v1`,
                    api_key: 'desktop-e2e',
                  },
                },
              },
            },
          }),
        })
        offlineModelId = offline.id
        assert.ok(offlineModelId, 'The offline fixture was not persisted')
        await selectE2EModel(control, offlineModelName, offlineModelName)
        await send(control, 'offline initial')
        await request(`/api/admin/public-models/${offlineModelId}`, {
          method: 'PUT',
          body: JSON.stringify({ is_visible: false }),
        })
        await reloadMainWindow(
          control,
          'The renderer did not reconnect after the model went offline'
        )
        await control.command('waitFor', taskSelector)
        await control.command('click', taskSelector)
        await control.command('waitFor', SELECTOR, { text: offlineModelName })
        // The hidden model is still a usable saved selection, unlike the
        // deleted-model recovery path, so the composer stays enabled.
        assert.equal(Number(await control.command('getElementCount', `${SELECTOR}:disabled`)), 0)
        await control.command('waitFor', SEND, { visible: true })
        await send(control, 'continue after offline')
        assert.equal(
          replyCount,
          5,
          'Continuing a task after its model went offline did not reach the model'
        )
        await assertOriginalConversation(control, identity, row)
      } finally {
        if (deletedModelId) await request(`/api/models/${deletedModelId}`, { method: 'DELETE' })
        if (offlineModelId) await deletePublicModel(offlineModelId)
      }
    },
  }
}
