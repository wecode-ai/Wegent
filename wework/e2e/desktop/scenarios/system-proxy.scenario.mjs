import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'

const MODEL_ORIGIN = 'http://wework-system-proxy.invalid'
const PROMPT = 'WEWORK_DESKTOP_E2E_SYSTEM_PROXY'
const COMPLETION = 'WEWORK_DESKTOP_E2E_SYSTEM_PROXY_COMPLETE'
const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`

function sse(events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function modelResponse() {
  const responseId = `wework-system-proxy-${Date.now()}`
  return sse([
    {
      type: 'response.created',
      response: { id: responseId },
    },
    {
      type: 'response.output_item.done',
      item: {
        id: `${responseId}-message`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: COMPLETION, annotations: [] }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    },
  ])
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function waitForProxyRequest(requests, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const request = requests.find(candidate => candidate.body.includes(PROMPT))
    if (request) return request
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Codex did not send the model request through the system proxy')
}

export async function createDesktopScenario({
  captureScreenshot,
  uiTimeoutMs,
  workspacePath,
  pac = false,
}) {
  let modelOrigin = MODEL_ORIGIN
  let proxyUrl
  let pacRequests = 0
  let rejectedProxyRequests = 0
  const requests = []
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', modelOrigin)
    if (pac && url.pathname === '/proxy.pac') {
      pacRequests += 1
      response.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig' })
      response.end(
        'function FindProxyForURL(url, host) { return host === "chatgpt.com" ? "PROXY ' +
          new URL(proxyUrl).host +
          '" : "DIRECT"; }'
      )
      return
    }
    if (pac && /^https?:/.test(request.url ?? '')) {
      rejectedProxyRequests += 1
      response.writeHead(403)
      response.end('Internal model requests must connect directly')
      return
    }
    if (
      url.origin !== modelOrigin ||
      request.method !== 'POST' ||
      url.pathname !== '/v1/responses'
    ) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }

    const body = await readBody(request)
    requests.push({
      body,
      method: request.method,
      url: request.url,
    })
    response.writeHead(200, {
      'Cache-Control': 'no-cache',
      'Content-Type': 'text/event-stream; charset=utf-8',
    })
    response.end(modelResponse())
  })
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string', 'Unable to start the system proxy fixture')
  proxyUrl = `http://127.0.0.1:${address.port}`
  if (pac) modelOrigin = proxyUrl

  return {
    electronLaunchArguments: [
      pac ? `--proxy-pac-url=${proxyUrl}/proxy.pac` : `--proxy-server=${proxyUrl}`,
    ],
    modelServerUrl: modelOrigin,

    async verify(control) {
      await control.command('navigate', 'body', { value: '/' })
      await createSingleRootLocalProject(control, workspacePath, 'system-proxy', uiTimeoutMs)
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
      await selectE2EModel(control, undefined, undefined, ACTIVE_WORKBENCH_SELECTOR)
      await control.command('fill', COMPOSER_SELECTOR, { value: PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })

      const proxiedRequest = await waitForProxyRequest(requests, uiTimeoutMs)
      if (pac) {
        assert.equal(
          proxiedRequest.url,
          '/v1/responses',
          'PAC DIRECT was incorrectly sent through the ChatGPT proxy'
        )
        assert.ok(pacRequests > 0, 'Electron did not load the PAC fixture')
        assert.equal(rejectedProxyRequests, 0, 'An internal request reached the external proxy')
      } else {
        assert.match(
          proxiedRequest.url,
          /^http:\/\/wework-system-proxy\.invalid\/v1\/responses$/,
          'Codex did not use absolute-form HTTP proxy routing'
        )
      }
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: COMPLETION,
        timeoutMs: uiTimeoutMs,
      })

      await control.command('navigate', 'body', { value: '/settings/general' })
      await control.command('waitFor', '[data-testid="settings-nav-proxy"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="settings-nav-proxy"]')
      await control.command('waitFor', '[data-testid="proxy-settings-page"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="local-proxy-effective-url"]', {
        text: proxyUrl,
        timeoutMs: uiTimeoutMs,
      })
      assert.match(
        await control.command('getText', '[data-testid="local-proxy-config-status"]'),
        /System proxy|系统代理/,
        'Proxy settings did not identify the effective proxy as the system proxy'
      )
      assert.equal(
        await control.command('getText', '[data-testid="local-proxy-effective-url"]'),
        proxyUrl,
        'Proxy settings did not show the proxy resolved by Electron'
      )
      await captureScreenshot(
        control,
        'system-proxy-01-settings.png',
        '[data-testid="proxy-config-local-device-section"]'
      )
    },

    async cleanup() {
      await new Promise(resolvePromise => server.close(resolvePromise))
    },

    diagnostics() {
      return {
        proxyUrl,
        requestCount: requests.length,
        pacRequests,
        rejectedProxyRequests,
      }
    },
  }
}
