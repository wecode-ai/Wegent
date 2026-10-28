import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from './executor-rpc.mjs'
import { rejectModelWebSocketUpgrade } from './reject-model-upgrade.mjs'

const MODEL = 'gpt-5.5'
const ACCOUNT = 'stand-in-config-e2e'
const MARKER = 'SUBSCRIPTION_CONFIG_RELOAD'

export function createSubscriptionConfigRegression() {
  let server
  let accountChecks = 0
  let modelRequests = 0
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
      const path = join(codexHome, 'config.toml')
      const config = await readFile(path, 'utf8')
      await writeFile(
        path,
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
      assert.equal(body.model, MODEL)
      assert.equal(request.headers.authorization, 'Bearer synthetic-subscription-access')
      assert.equal(request.headers['chatgpt-account-id'], ACCOUNT)
      modelRequests += 1
      return true
    },
    async verify(control, projectId, workspacePath, uiTimeoutMs, modelResponseTimeoutMs) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
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
              userId: 9001,
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
            user_id: 9001,
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
