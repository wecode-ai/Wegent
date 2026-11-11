import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor, writeCodexModelConfig } from './executor-rpc.mjs'
import { rejectModelWebSocketUpgrade } from './reject-model-upgrade.mjs'
import { MODEL_PROVIDER_ID } from './shared.mjs'
import { openStandInSettings } from './stand-in-profile-navigation.mjs'
import { until } from './plugin-regression-fixture.mjs'

const MODEL = 'gpt-6.1-sol'
const ACCOUNT = 'stand-in-config-e2e'
const MARKER = 'SUBSCRIPTION_CONFIG_RELOAD'
const IMPLICIT_TASK = `${MARKER}-model-less`

export function implicitSubscriptionTask(userId, workspacePath) {
  return {
    taskId: IMPLICIT_TASK,
    title: IMPLICIT_TASK,
    runtime: 'codex',
    workspacePath,
    message: IMPLICIT_TASK,
    clientUserMessageId: `${IMPLICIT_TASK}-initial`,
    executionRequest: {
      task_id: IMPLICIT_TASK,
      subtask_id: `${IMPLICIT_TASK}-initial`,
      user_id: userId,
      prompt: IMPLICIT_TASK,
      new_session: true,
      bot: [{ shell_type: 'Codex', name: 'Implicit subscription default regression' }],
      model_config: {},
    },
  }
}

export function assertSubscriptionModelRequest(request, body, expectedModel = MODEL) {
  assert.equal(body.model, expectedModel)
  assert.equal(request.headers.authorization, 'Bearer synthetic-subscription-access')
  assert.equal(request.headers['chatgpt-account-id'], ACCOUNT)
}

export function createSubscriptionConfigRegression() {
  let server
  let configPath
  let accountChecks = 0
  let modelRequests = 0
  let implicitRequest
  return {
    async prepareApp({ appEnvironment, codexHome, control }) {
      delete appEnvironment.OPENAI_API_KEY
      // Only the model service and its subscription-account endpoints are synthetic.
      // A distinct bootstrap origin keeps the explicit local model route independent.
      server = createServer((request, response) => {
        if (request.url?.startsWith('/backend-api/wham/accounts/check')) {
          accountChecks += 1
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(
            JSON.stringify({
              accounts: [
                {
                  id: ACCOUNT,
                  workspace_backend_origin: 'https://chatgpt.com',
                  account_routing_override: 'NO_CONSTRAINT',
                },
              ],
            })
          )
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const bootstrap = `http://127.0.0.1:${server.address().port}/backend-api/`
      const claims = Buffer.from(
        JSON.stringify({
          email: 'stand-in-config@example.test',
          exp: Math.floor(Date.now() / 1000) + 3600,
          'https://api.openai.com/auth': {
            chatgpt_account_id: ACCOUNT,
            chatgpt_plan_type: 'pro',
          },
        })
      ).toString('base64url')
      await writeFile(
        join(codexHome, 'auth.json'),
        JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: {
            account_id: ACCOUNT,
            access_token: 'synthetic-subscription-access',
            refresh_token: 'synthetic-subscription-refresh',
            id_token: `header.${claims}.signature`,
          },
          last_refresh: new Date().toISOString(),
        })
      )
      configPath = join(codexHome, 'config.toml')
      const config = await readFile(configPath, 'utf8')
      await writeFile(
        configPath,
        `openai_base_url = "${control.url}/backend-api/codex"\nchatgpt_base_url = "${bootstrap}"\n${config}`
      )
    },
    attachServer(server) {
      server.on('upgrade', (_request, socket) => {
        // Registering an upgrade listener transfers ownership of every upgraded socket.
        // A model service may require HTTP; Codex handles 426 through its native fallback.
        rejectModelWebSocketUpgrade(server, socket)
      })
    },
    acceptsModelRequest(request, url, body) {
      if (url.pathname !== '/backend-api/codex/responses') return false
      const latestUser = (body.input ?? []).filter(item => item.role === 'user').at(-1)
      const implicit = JSON.stringify(latestUser?.content ?? '').includes(IMPLICIT_TASK)
      if (implicit)
        assert.ok(implicitRequest, 'An implicit task must have a measured native default')
      assertSubscriptionModelRequest(request, body, implicit ? implicitRequest.model : MODEL)
      if (implicit) implicitRequest.calls += 1
      modelRequests += 1
      return true
    },
    async verify(control, projectId, workspacePath, uiTimeoutMs, modelResponseTimeoutMs, userId) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const native = (method, params) => rpc('runtime.codex.app_server.request', { method, params })
      const setCatalogConfig = (provider, model) =>
        writeCodexModelConfig(control, { provider, model }, uiTimeoutMs)
      const readSavedModelConfig = async () => {
        const result = await native('config/read', { includeLayers: true, cwd: null })
        // Effective config includes the shared router's CLI provider override.
        const users = result.layers.filter(
          layer => layer.name.type === 'user' && layer.name.profile == null
        )
        assert.equal(users.length, 1, 'The isolated fixture must have one base user config layer')
        assert.equal(users[0].name.file, configPath)
        return {
          model: users[0].config.model,
          model_provider: users[0].config.model_provider,
        }
      }
      for (const initiatedBy of ['user', 'stand_in', null]) {
        const label = initiatedBy ?? 'direct'
        const issue = await rpc('todos.create', {
          project_id: projectId,
          todo: { title: `${MARKER}_${label}` },
        })
        const origin = initiatedBy
          ? {
              type: 'issue_dispatch',
              dispatchRole: 'executor',
              initiatedBy,
              userId,
              projectStore: 'local',
              cloudProjectId: projectId,
              loopItemId: issue.id,
              askBeforeAct: initiatedBy === 'stand_in',
            }
          : undefined
        const taskId = `${MARKER}-${label}`
        const before = modelRequests
        await rpc('runtime.tasks.create', {
          taskId,
          title: taskId,
          runtime: 'codex',
          workspacePath,
          message: taskId,
          clientUserMessageId: `${taskId}-initial`,
          origin,
          modelSelection: {
            modelName: MODEL,
            modelType: 'runtime',
            options: { runnerModelProvider: 'openai' },
          },
          executionRequest: {
            task_id: taskId,
            subtask_id: `${taskId}-initial`,
            user_id: userId,
            prompt: taskId,
            new_session: true,
            bot: [{ shell_type: 'Codex', name: 'Subscription configuration regression' }],
            model_config: { model_id: MODEL, model_provider: 'openai' },
            origin,
          },
        })
        const deadline = Date.now() + modelResponseTimeoutMs
        let task
        while (Date.now() < deadline) {
          task = (await rpc('runtime.tasks.get', { taskId })).task
          assert.notEqual(task?.status, 'failed', JSON.stringify(task))
          if (task?.status === 'done') break
          await new Promise(resolve => setTimeout(resolve, 200))
        }
        assert.equal(task?.status, 'done', JSON.stringify(task))
        assert.ok(modelRequests > before, 'The subscription task must reach the model service')
      }
      const previousConfig = await native('config/read', { includeLayers: false, cwd: null })
      const previousModel = previousConfig.config.model
      assert.equal(typeof previousModel, 'string', 'The isolated fixture must have a default model')
      let expectedDefault
      try {
        // The real subscription turns above establish ChatGPT authentication.
        // Measure the normal native default before configuring the retired model.
        await setCatalogConfig('openai', null)
        const account = await rpc('runtime.codex.auth.read', {})
        assert.equal(
          account.account,
          null,
          'The shared router must not be mistaken for the saved subscription account'
        )
        const nativeDefaults = new Map()
        for (const includeHidden of [true, false]) {
          const nativeCatalog = await rpc('runtime.codex.models.list', { includeHidden })
          const defaults = nativeCatalog.data.filter(
            model =>
              model.providerId === 'openai' &&
              model.providerType === 'official' &&
              model.isDefault &&
              !model.hidden
          )
          assert.equal(
            defaults.length,
            1,
            'The normal native catalog must have one visible default'
          )
          nativeDefaults.set(includeHidden, defaults[0].model ?? defaults[0].id)
        }
        await setCatalogConfig('openai', 'gpt-5.5')
        for (const includeHidden of [true, false]) {
          const nativeDefaultId = nativeDefaults.get(includeHidden)
          const catalog = await rpc('runtime.codex.models.list', { includeHidden })
          assert.ok(Array.isArray(catalog.data))
          const official = catalog.data.filter(
            model => model.providerId === 'openai' && model.providerType === 'official'
          )
          assert.equal(
            official.some(model => (model.model ?? model.id) === 'gpt-5.5'),
            false,
            `ChatGPT catalog must exclude GPT-5.5 (includeHidden=${includeHidden})`
          )
          assert.ok(
            official.some(model => (model.model ?? model.id) === MODEL),
            `ChatGPT catalog must retain ${MODEL} (includeHidden=${includeHidden})`
          )
          expectedDefault = official.find(
            model => (model.model ?? model.id) === nativeDefaultId && !model.hidden
          )
          assert.ok(expectedDefault, 'The normal native default must remain available')
          assert.deepEqual(
            official.filter(model => model.isDefault).map(model => model.model ?? model.id),
            [expectedDefault.model ?? expectedDefault.id],
            'Retiring the configured default must publish one available native default'
          )
        }
        const catalog = await rpc('runtime.runner.catalog', {})
        assert.ok(Array.isArray(catalog.models))
        const official = catalog.models.filter(
          model => model.runtime === 'codex' && model.provider === 'openai'
        )
        assert.equal(
          official.some(model => model.model_id === 'gpt-5.5'),
          false,
          'The ChatGPT runner catalog must exclude GPT-5.5'
        )
        assert.ok(
          official.some(model => model.model_id === MODEL),
          `The ChatGPT runner catalog must retain ${MODEL}`
        )
        assert.deepEqual(
          official.filter(model => model.is_default).map(model => model.model_id),
          [expectedDefault.model ?? expectedDefault.id],
          'Background work and the picker must receive the same effective default'
        )
        const defaultModel = expectedDefault.model ?? expectedDefault.id
        assert.notEqual(defaultModel, 'gpt-5.5', 'The implicit native default must be available')
        const savedConfig = await readSavedModelConfig()
        assert.deepEqual(savedConfig, { model: 'gpt-5.5', model_provider: 'openai' })
        implicitRequest = { model: defaultModel, calls: 0 }
        const intent = implicitSubscriptionTask(userId, workspacePath)
        for (const key of ['modelSelection', 'modelId', 'modelOptions']) {
          assert.equal(
            Object.hasOwn(intent, key),
            false,
            'The task must use implicit model selection'
          )
        }
        assert.deepEqual(intent.executionRequest.model_config, {})
        await rpc('runtime.tasks.create', intent)
        await until(
          () => rpc('runtime.tasks.get', { taskId: IMPLICIT_TASK }),
          result => {
            assert.notEqual(result.task?.status, 'failed', JSON.stringify(result))
            return result.task?.status === 'done' && result.task.running !== true
          },
          'The implicit task did not finish through the corrected native default',
          modelResponseTimeoutMs
        )
        assert.ok(
          implicitRequest.calls > 0,
          'The model-less task must reach the subscription service'
        )
        await until(
          () => rpc('runtime.tasks.transcript', { taskId: IMPLICIT_TASK, limit: 50 }),
          transcript =>
            transcript.messages.some(
              message =>
                message.role === 'user' && JSON.stringify(message.content).includes(IMPLICIT_TASK)
            ) &&
            transcript.messages.some(
              message =>
                message.role === 'assistant' &&
                JSON.stringify(message.content).includes('已完成任务，等待检查。')
            ),
          'The real implicit task transcript must contain its request and the model service answer'
        )
        assert.deepEqual(
          await readSavedModelConfig(),
          savedConfig,
          'Execution must not rewrite the saved model or provider'
        )
        await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
        await control.command('waitFor', '[data-testid="stand-in-overview"]')
        await openStandInSettings(control)
        await control.command(
          'clickWhenEnabled',
          '[data-testid="stand-in-primary-profile"] [data-testid="model-selector-button"]'
        )
        const option = id =>
          `[data-testid=${JSON.stringify(`model-option-${JSON.stringify(['codex', 'openai', id])}`)}]`
        await control.command('waitFor', option(MODEL))
        assert.equal(
          await control.command('getElementCount', option('gpt-5.5')),
          '0',
          'The loaded stand-in model picker must exclude GPT-5.5'
        )
        await control.command('press', 'body', { key: 'Escape' })
        await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-profile-close"]')
        await control.command('waitFor', '[data-testid="stand-in-profile-panel"]', {
          visible: false,
        })
      } finally {
        try {
          if (implicitRequest) {
            const result = await rpc('runtime.tasks.get', { taskId: IMPLICIT_TASK })
            if (result.task) {
              assert.equal(
                (await rpc('runtime.tasks.archive', { taskId: IMPLICIT_TASK })).accepted,
                true
              )
              const deleted = await rpc('runtime.archived_conversations.delete', {
                taskId: IMPLICIT_TASK,
              })
              assert.equal(deleted.accepted, true)
              assert.equal(deleted.deleted, true)
            } else {
              assert.equal(result.code, 'task_not_found')
            }
          }
        } finally {
          implicitRequest = undefined
          await setCatalogConfig(MODEL_PROVIDER_ID, previousModel)
        }
      }
      assert.ok(accountChecks > 0, 'The real Codex subscription routing resolver must run')
    },
    async cleanup() {
      if (!server) return
      server.closeAllConnections()
      await new Promise((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
    },
  }
}
