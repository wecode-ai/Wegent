import {
  verifyRealCloudCredentials,
  verifyNativePluginAdmission,
} from '../modules/security-credential-flows.mjs'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { createLinkedDocumentFixture } from '../modules/office-preview-fixtures.mjs'
import { fetchLocalRuntime, invokeLocalHost } from '../modules/runtime-request.mjs'
import { createLocalProject } from '../modules/streaming-text-fixture.mjs'
import { selectE2EModel } from '../modules/shared.mjs'
import { sendPrompt } from '../modules/conversation-navigation.mjs'
import { TransportFaultProxy } from '../modules/transport-fault-proxy.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const SECRET = 'e2e-native-only-key-security-boundary'
const MODEL = 'security-boundary-probe'
const MARKER = 'data-security-link-executed'
const COMPOSER =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"] [data-testid="chat-message-input"]'

export function createDesktopScenario({
  workspacePath,
  electronUserDataDirectory,
  restartDesktopApp,
  uiTimeoutMs,
  resultDir,
}) {
  let nativeProbes = 0
  let cloud
  let proxy
  // This checkpoint uses production login and restart restoration, never token seeding.
  const appEnvironment = {
    WEWORK_E2E_CLOUD_BACKEND_URL: '',
    VITE_WEWORK_E2E_CLOUD_BACKEND_URL: '',
    WEWORK_E2E_CLOUD_TOKEN: '',
    VITE_WEWORK_E2E_CLOUD_TOKEN: '',
  }
  return {
    requiresCloudEnvironment: true,
    requiresRemoteExecutor: false,
    appEnvironment,
    setCloudEnvironment(environment) {
      cloud = environment
    },
    async prepareCloud({ backendUrl }) {
      proxy = await new TransportFaultProxy(backendUrl).start()
      appEnvironment.WEWORK_BACKEND_URL = proxy.url
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST') return false
      if (url.pathname === '/v1/chat/completions') {
        const body = await readRequestBody(request)
        if (body.model !== MODEL) return false
        assert.equal(request.headers.authorization, `Bearer ${SECRET}`)
        nativeProbes += 1
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      type: 'function',
                      function: { name: 'wework_capability_probe', arguments: '{"input":"PING"}' },
                    },
                  ],
                },
              },
            ],
          })
        )
        return true
      }
      if (!['/responses', '/v1/responses'].includes(url.pathname)) return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      const id = `security-boundaries-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        createSse([
          responseCreated(id),
          assistantMessage(
            `SECURITY_PREVIEW_READY\n\n[Security document](${workspacePath}/security-links.docx)`
          ),
          responseCompleted(id),
        ])
      )
      return true
    },
    async verify(control) {
      await verifyRealCloudCredentials({
        control,
        cloud,
        proxy,
        electronUserDataDirectory,
        restartDesktopApp,
        resultDir,
      })
      await verifyNativePluginAdmission({ control, electronUserDataDirectory, resultDir })

      const payload = `document.body.setAttribute('${MARKER}','yes')`
      const links = [
        { target: `javascript:${payload}`, type: 'image' },
        { target: `JaVaScRiPt:${payload}` },
        { target: `java\nscript:${payload}` },
        { target: 'data:text/html,<script>document.title="unexpected"</script>' },
        { target: 'file:///private/security-boundary-test' },
        { target: 'https://example.test/security-positive-control' },
      ].map((link, index) => ({ ...link, label: `SECURITY_LINK_${index}` }))
      await createLinkedDocumentFixture(join(workspacePath, 'security-links.docx'), links)
      await createLocalProject(control, workspacePath, uiTimeoutMs)
      await selectE2EModel(control)
      await sendPrompt(control, COMPOSER, 'SECURITY_PREVIEW_TASK')
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: 'SECURITY_PREVIEW_READY',
        timeoutMs: uiTimeoutMs,
      })
      await control.command(
        'click',
        '[data-testid="assistant-markdown-link"][aria-label$="/security-links.docx"]'
      )
      await control.command('waitFor', '.docx-wrapper', { text: 'SECURITY_LINK_5' })
      for (let index = 0; index < links.length; index += 1) {
        const anchor = `.docx-wrapper p:nth-of-type(${index + 1}) a`
        const href = await control.command('getAttribute', anchor, { value: 'href' })
        if (index === links.length - 1) {
          assert.equal(href, links[index].target, 'Ordinary HTTP links must survive sanitization')
        } else {
          assert.equal(href, '#', 'Every unsafe relationship must be inert before clicking')
          await control.command('click', anchor)
          assert.notEqual(await control.command('getAttribute', 'body', { value: MARKER }), 'yes')
        }
      }
      await control.command('waitFor', `body:not([${MARKER}="yes"])`, { stableMs: 300 })
      const origin = await control.command('getLocationOrigin', 'body')
      for (const operation of ['get', 'set', 'delete']) {
        const response = await fetchLocalRuntime(
          control,
          `${origin}/wework/electron-host/v1/invoke`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              capability: `secureStorage.${operation}`,
              params: { key: 'model-key', value: SECRET },
            }),
          }
        )
        assert.equal(
          response.status,
          403,
          `Authenticated HTTP secureStorage.${operation} must fail`
        )
        assert.equal((await response.json()).error.code, 'capability_denied')
      }
      const before = await invokeLocalHost(control, 'modelConfiguration.read')
      assert.ok(
        !relative(electronUserDataDirectory, before.path).startsWith('..'),
        'Only mutate the isolated E2E model file'
      )
      const provider = {
        id: 'security-boundary-provider',
        name: 'Security boundary probe',
        base_url: `http://127.0.0.1:${process.env.WEWORK_E2E_MODEL_SERVER_PORT}/v1`,
        api_format: 'openai-chat-completions',
        api_key: SECRET,
        models: [{ id: MODEL, model_id: MODEL }],
      }
      const originalProviders = before.providers.map(
        ({ api_key_configured, ...metadata }) => metadata
      )
      await mkdir(dirname(before.path), { recursive: true, mode: 0o700 })
      try {
        // Exercise the supported legacy inline-key migration, rather than bypassing native storage.
        await writeFile(
          before.path,
          JSON.stringify({ version: 1, providers: [...originalProviders, provider] }),
          { mode: 0o600 }
        )
        await invokeLocalHost(control, 'modelConfiguration.read')
        const yaml = await readFile(before.path, 'utf8')
        assert.ok(!yaml.includes(SECRET), 'Inline credentials must leave the model file')
        assert.ok(yaml.includes('api_key_ref'))
        const protectedDirectory = join(electronUserDataDirectory, 'protected-credentials')
        const stored = await readFile(join(protectedDirectory, 'secure-values.json'), 'utf8')
        assert.equal(JSON.parse(stored).version, 3)
        assert.ok(!stored.includes(SECRET))
        await assert.rejects(readFile(join(protectedDirectory, 'secure-values.key')), {
          code: 'ENOENT',
        })
        await restartDesktopApp()
        const metadata = await invokeLocalHost(control, 'modelConfiguration.runtime')
        assert.ok(
          !JSON.stringify(metadata).includes(SECRET),
          'Runtime metadata must not expose plaintext credentials'
        )
        assert.ok(
          metadata.models.some(
            entry => entry.model.id === MODEL && entry.provider.api_key_configured
          )
        )
        const { api_key, ...draft } = provider
        assert.deepEqual(
          await invokeLocalHost(control, 'modelConfiguration.test', { provider: draft }),
          [{ model: MODEL }]
        )
        assert.equal(
          nativeProbes,
          1,
          'A saved OS-protected key must still authenticate a real native model request after restart'
        )
      } finally {
        const current = await invokeLocalHost(control, 'modelConfiguration.read')
        await invokeLocalHost(control, 'modelConfiguration.save', {
          revision: current.revision,
          providers: originalProviders,
        })
      }
      await writeFile(
        join(resultDir, 'security-boundaries-result.json'),
        JSON.stringify(
          {
            completed: true,
            sourceSha: process.env.GITHUB_SHA ?? null,
            checks: [
              'real-cloud-login-restart-refresh-authentication-and-logout-marker',
              'native-plugin-install-update-and-development-cancel-and-allow',
              'docx-unsafe-links-inert-and-https-preserved',
              'renderer-secure-storage-denied',
              'model-key-protected-and-native-authentication-after-restart',
            ],
          },
          null,
          2
        )
      )
    },
    async cleanup() {
      await proxy?.stop()
    },
  }
}
