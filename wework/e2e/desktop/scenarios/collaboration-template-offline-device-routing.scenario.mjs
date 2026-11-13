import assert from 'node:assert/strict'

import { createDesktopScenario as createAppDeviceRoutingScenario } from './collaboration-template-app-device-routing.scenario.mjs'
import { verifyProjectAgentRoutingRecovery } from '../modules/project-agent-routing-recovery.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

export function createDesktopScenario(options) {
  const scenario = createAppDeviceRoutingScenario(options)
  let environment
  let cloud
  return {
    ...scenario,
    async prepareCloud(value) {
      cloud = value
      await scenario.prepareCloud(value)
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      await readRequestBody(request)
      const id = `project-agent-recovery-${Date.now()}`
      const message = assistantMessage('Execution verified.')
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), message, responseCompleted(id, [message.item])]))
      return true
    },
    setCloudEnvironment(value) {
      environment = value
      scenario.setCloudEnvironment(value)
    },
    async verify(control) {
      // Register and disconnect a real Executor to retain a historical identity.
      const historical = await environment.createOfflineLocalSidebarAlias()
      const current = await environment.waitForConnectedAppDevice()
      const persisted = (await environment.devices()).find(device => device.id === historical.id)
      assert.equal(persisted?.status, 'offline')
      assert.equal(historical.device_id, current.app_device_id)
      assert.notEqual(historical.id, current.id)
      await scenario.verify(control)
      await verifyProjectAgentRoutingRecovery(control, cloud, historical, options)
    },
  }
}
