import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  createSingleRootLocalProject,
  selectE2EModel,
  fetchJson,
  CLOUD_PUBLIC_MODEL_NAME,
} from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  handleModelMaintenanceRequest,
  readRequestBody,
  responseCompleted,
  responseCreated,
  functionCall,
  customToolCall,
} from '../modules/response-protocol.mjs'
import { programmaticExecTools } from '../modules/model-tool-catalog.mjs'
import {
  shellCommandResponse,
  shellCommandPollResponse,
} from '../modules/shell-command-response.mjs'
import { accountCommandResult } from '../modules/account-auth-command.mjs'
import { reloadMainWindow } from '../modules/workspace-flows.mjs'

const MODEL = 'custom-responses-model'
const MODEL_ID = 'responses-tool-compatibility'
const CLOUD_MODEL = 'responses-cloud-tool-compatibility'
const PROMPT = 'RESPONSES_TOOL_COMPATIBILITY'
const TOOL_OK = 'RESPONSES_SHELL_OK'
const DONE = 'RESPONSES_TOOL_COMPLETED'
const API_KEY = 'responses-protocol-fixture-key'
const ERROR = "Unsupported custom tool: 'exec'. Only 'apply_patch' is supported."

/** Exercise the real desktop/runtime/Codex chain against a strict model protocol oracle. */
export function createDesktopScenario({ electronUserDataDirectory, workspacePath, resultDir }) {
  const requests = []
  let probeRequests = 0
  let nativeProbeRequests = 0
  let round = 1
  let cloudEnvironment
  let cloudModelId
  const cloudRequest = (path, options = {}) =>
    fetchJson(`${cloudEnvironment.backendUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${cloudEnvironment.authToken}`,
        'Content-Type': 'application/json',
      },
    })
  const artifact = join(workspacePath, 'responses-tool-compatibility.txt')
  return {
    requiresCloudEnvironment: true,
    async prepareCloud(cloud) {
      cloudEnvironment = cloud
      await cloudRequest('/api/admin/setup-complete', { method: 'POST' })
      const catalog = await cloudRequest('/api/admin/public-models?limit=1000')
      const upstream = catalog.items.find(model => model.name === CLOUD_PUBLIC_MODEL_NAME)
      assert.ok(upstream, 'The real Backend must provide the upstream model fixture')
      const created = await cloudRequest('/api/admin/public-models', {
        method: 'POST',
        body: JSON.stringify({
          name: CLOUD_MODEL,
          namespace: 'default',
          json: {
            apiVersion: 'agent.wecode.io/v1',
            kind: 'Model',
            metadata: {
              name: CLOUD_MODEL,
              namespace: 'default',
              displayName: 'Portable Responses',
            },
            spec: {
              protocol: 'openai-responses',
              apiFormat: 'responses',
              modelType: 'llm',
              isVisible: true,
              isWeworkAvailable: true,
              modelConfig: {
                env: { ...upstream.json.spec.modelConfig.env, model_id: MODEL, api_key: API_KEY },
              },
            },
          },
        }),
      })
      cloudModelId = created.id
    },
    async prepareApp() {
      const directory = join(electronUserDataDirectory, 'model-connections')
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, 'model.yml'),
        JSON.stringify({
          version: 1,
          providers: [
            {
              id: MODEL_ID,
              name: 'Responses protocol regression',
              base_url: `http://127.0.0.1:${process.env.WEWORK_E2E_MODEL_SERVER_PORT}`,
              api_format: 'openai-responses',
              request_path: '/compat/responses',
              api_key: API_KEY,
              models: [
                {
                  id: MODEL_ID,
                  model_id: MODEL,
                  codex_catalog_model_id: 'wework-gpt-6.1-sol',
                },
                {
                  id: `${MODEL_ID}-native`,
                  model_id: `${MODEL}-native`,
                  tool_profile: 'custom',
                  codex_tool_compatibility: 'native',
                  codex_catalog_model_id: 'wework-gpt-6.1-sol',
                },
              ],
            },
          ],
        }),
        { mode: 0o600 }
      )
    },
    async handleHttp(request, response, url) {
      if (!['/compat/responses', '/responses', '/v1/responses'].includes(url.pathname)) return false
      const body = await readRequestBody(request)
      if (![MODEL, `${MODEL}-native`].includes(body.model)) return false
      if (handleEmptyReplyPrediction(body, response)) return true
      if (handleModelMaintenanceRequest(body, response)) return true
      assert.equal(request.headers.authorization, `Bearer ${API_KEY}`)
      const native = body.model === `${MODEL}-native`
      if (body.tools?.some(tool => tool.name === 'wework_capability_probe')) {
        probeRequests += 1
        const id = `probe-${probeRequests}`
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          createSse([
            responseCreated(id),
            ...functionCall(
              id,
              'wework_capability_probe',
              probeRequests === 1 ? {} : { input: 'PING' }
            ),
            responseCompleted(id),
          ])
        )
        return true
      }
      if (native && body.tools?.some(tool => tool.name === 'apply_patch')) {
        nativeProbeRequests += 1
        const id = `native-probe-${nativeProbeRequests}`
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          createSse([
            responseCreated(id),
            customToolCall(
              id,
              'apply_patch',
              '*** Begin Patch\n*** Add File: connection-probe.txt\n+PING\n*** End Patch\n'
            ),
            responseCompleted(id),
          ])
        )
        return true
      }
      const tools = programmaticExecTools(body)
      const rejected = !native && tools.some(tool => tool.type === 'custom')
      requests.push({
        round,
        native,
        rejected,
        tools: tools.map(({ type, name, namespace }) => ({ type, name, namespace })),
      })
      await writeFile(
        join(resultDir, 'responses-tool-compatibility-requests.json'),
        JSON.stringify(requests, null, 2)
      )
      if (rejected) {
        response.writeHead(400, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            error: { message: ERROR, type: 'invalid_request_error', code: 'invalid_request_error' },
          })
        )
        return true
      }
      assert.equal(tools.length, 1, 'The model must receive the real Code Mode exec declaration')
      assert.equal(tools[0].type, native ? 'custom' : 'function')
      if (!native) assert.equal(tools[0].parameters.properties.input.type, 'string')
      const callId = `responses-exec-${round}`
      const result = accountCommandResult(body.input, callId)
      let events
      if (result?.sessionId) {
        events = shellCommandPollResponse(body, result.pollId, result.sessionId)
      } else if (result) {
        assert.ok(result.output.includes(TOOL_OK), result.output)
        assert.equal(await readFile(artifact, 'utf8'), TOOL_OK)
        const calls = body.input.filter(item => item.call_id === callId)
        assert.equal(calls[0].type, native ? 'custom_tool_call' : 'function_call')
        assert.equal(calls[0].namespace, tools[0].namespace)
        assert.equal(calls[0].name, tools[0].name)
        assert.equal(
          typeof (native ? calls[0].input : JSON.parse(calls[0].arguments).input),
          'string'
        )
        assert.equal(calls[1].type, native ? 'custom_tool_call_output' : 'function_call_output')
        events = [assistantMessage(`${DONE} ${round}`)]
      } else {
        const script =
          round === 1
            ? `require('node:fs').writeFileSync(${JSON.stringify(artifact)}, ${JSON.stringify(TOOL_OK)}); console.log(${JSON.stringify(TOOL_OK)})`
            : `require('node:assert/strict').equal(require('node:fs').readFileSync(${JSON.stringify(artifact)}, 'utf8'), ${JSON.stringify(TOOL_OK)}); console.log(${JSON.stringify(TOOL_OK)})`
        events = shellCommandResponse(
          body,
          callId,
          `node -e ${"'" + script.replaceAll("'", "'\\''") + "'"}`,
          workspacePath
        )
      }
      const id = `responses-response-${requests.length}`
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      const errors = []
      try {
        await control.command('navigate', 'body', { value: '/settings/personal/models' })
        await control.command('waitFor', `[data-testid="provider-row-${MODEL_ID}"]`)
        await control.command('click', `[data-testid="provider-row-${MODEL_ID}"] > summary`)
        await control.command('click', `[data-testid="provider-model-edit-${MODEL_ID}"]`)
        const editor = `[data-testid="provider-model-editor-${MODEL_ID}"]`
        const compatibility = `[data-testid="provider-model-compatibility-${MODEL_ID}"]`
        await control.command('click', `${editor} details:has(${compatibility}) > summary`)
        await control.command('waitFor', compatibility)
        assert.equal(await control.command('getValue', compatibility), 'standard')
        await control.command('click', '[data-testid="local-model-advanced-capabilities-toggle"]')
        await control.command('waitFor', '[data-testid="local-model-advanced-capabilities-dialog"]')
        assert.equal(
          await control.command(
            'getValue',
            '[data-testid="local-model-codex-tool-compatibility-select"]'
          ),
          'standard'
        )
        await control.command('click', '[data-testid="local-model-advanced-capabilities-close"]')
        const probe = '[data-testid="provider-editor-test"]'
        const probeResult = '[data-testid="provider-editor-test-result"]'
        await control.command('clickWhenEnabled', probe)
        await control.command('waitFor', `${probeResult}[role="alert"]`)
        await control.command('click', '[data-testid="provider-editor-test-error-details"]')
        await control.command('waitFor', `${probeResult}[role="alert"]`, {
          text: '连接失败',
        })
        assert.equal(probeRequests, 1, 'The invalid function arguments must be rejected')
        assert.equal(nativeProbeRequests, 1, 'Both configured tool protocols must be probed')
        await control.command('clickWhenEnabled', probe)
        await control.command('waitFor', `${probeResult}[role="status"]`)
        assert.equal(
          probeRequests,
          2,
          'Invalid arguments must fail before a valid probe can recover'
        )
        assert.equal(
          nativeProbeRequests,
          2,
          'Native probes must retain their selected tool protocol'
        )
        await control.command('click', '[data-testid="provider-editor-cancel"]')
        await control.command('navigate', 'body', { value: '/' })
        await createSingleRootLocalProject(control, workspacePath, 'Responses compatibility')
        await selectE2EModel(control, `local-model:${MODEL_ID}`, MODEL)
        for (round = 1; round <= 3; round += 1) {
          if (round === 2) {
            await reloadMainWindow(control)
            await selectE2EModel(control, CLOUD_MODEL, 'Portable Responses')
          }
          if (round === 3)
            await selectE2EModel(control, `local-model:${MODEL_ID}-native`, `${MODEL}-native`)
          await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: `${PROMPT} ${round}` })
          await control.command(
            'clickWhenEnabled',
            `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
          )
          await control.command(
            'waitFor',
            `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
            { text: `${DONE} ${round}` }
          )
          assert.equal(await readFile(artifact, 'utf8'), TOOL_OK)
        }
        assert.ok(requests.length >= 6, 'Local, cloud and native turns must execute real tools')
        assert.ok(requests.every(request => !request.rejected))
      } catch (error) {
        errors.push(error)
      } finally {
        if (cloudEnvironment && cloudModelId != null) {
          try {
            const deleted = await fetch(
              `${cloudEnvironment.backendUrl}/api/admin/public-models/${cloudModelId}`,
              {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${cloudEnvironment.authToken}` },
              }
            )
            assert.equal(deleted.status, 204)
          } catch (error) {
            errors.push(error)
          }
        }
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1)
        throw new AggregateError(errors, 'Responses verification and cleanup failed')
    },
    diagnostics() {
      return { requests, probeRequests, nativeProbeRequests }
    },
  }
}
