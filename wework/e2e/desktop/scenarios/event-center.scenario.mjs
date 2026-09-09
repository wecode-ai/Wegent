import assert from 'node:assert/strict'
import { eventCenterModelResponse, verifyEventCenter } from '../modules/event-center-flows.mjs'
import {
  assistantMessage,
  createSse,
  responseCreated,
  responseCompleted,
} from '../modules/response-protocol.mjs'

export function createDesktopScenario({ captureScreenshot }) {
  let cloud
  let sequence = 0
  const request = async (path, options = {}) => {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${cloud.authToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })
    assert.ok(response.ok, `${options.method ?? 'GET'} ${path} failed with ${response.status}`)
    return response.json()
  }
  const waitForValue = async (read, predicate, message, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = await read()
      if (predicate(value)) return value
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.fail(message)
  }
  return {
    requiresCloudEnvironment: true,
    async prepareCloud(value) {
      cloud = value
    },
    async handleHttp(req, response, url) {
      if (req.method !== 'POST' || url.pathname !== '/v1/responses') return false
      let body = ''
      for await (const chunk of req) body += chunk
      const payload = JSON.parse(body)
      const id = `event-center-${++sequence}`
      const events = (await eventCenterModelResponse(payload, id, request)) ?? [
        responseCreated(id),
        assistantMessage('已核对结果。'),
        responseCompleted(id),
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.end(createSse(events))
      return true
    },
    async verify(control) {
      const runtimeProfile = await request('/api/v1/runtime-profiles', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Event center Runtime',
          executionEnvironment: 'cloud',
          executionDeviceId: 'wework-e2e-cloud-device',
          model: 'desktop-e2e-public-model',
          modelType: 'public',
          modelOptions: {
            weworkCloudModelNamespace: 'default',
            weworkCloudModelResourceUserId: '0',
            weworkCloudModelUpstreamApiFormat: 'openai-responses',
          },
          workspacePolicy: 'project',
        }),
      })
      await verifyEventCenter({
        control,
        request,
        runtimeProfile,
        captureScreenshot,
        waitForValue,
        timeoutMs: 80000,
      })
    },
  }
}
