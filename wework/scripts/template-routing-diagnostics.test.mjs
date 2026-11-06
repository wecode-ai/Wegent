import { afterEach, expect, test, vi } from 'vitest'
import { logTemplateRoutingFailure } from '../e2e/desktop/scenarios/collaboration-template-app-device-routing.scenario.mjs'

afterEach(() => vi.restoreAllMocks())

test('records device identities and grants without authentication or model configuration', async () => {
  const output = vi.spyOn(console, 'error').mockImplementation(() => {})
  const secret = 'diagnostic-secret-must-not-be-logged'
  const device = {
    id: 42,
    device_key: 'route-key',
    app_device_id: 'app-key',
    status: 'online',
    token: secret,
    model: { api_key: secret },
  }
  const control = {
    command: async () =>
      JSON.stringify({ deviceId: 'app-key', running: true, ready: true, authToken: secret }),
  }
  const request = async path => {
    if (path.includes('/resources?')) return { execution_environments: [device] }
    if (path.endsWith('/projects')) return { items: [{ id: 'project', name: 'Template project' }] }
    return { items: [device], token: secret }
  }

  await logTemplateRoutingFailure({
    control,
    request,
    workspaceId: 'workspace',
    projectName: 'Template project',
    appDevice: device,
  })

  expect(output).toHaveBeenCalledOnce()
  const payload = JSON.parse(output.mock.calls[0][1])
  expect(payload.local).toEqual({ deviceId: 'app-key', running: true, ready: true })
  expect(payload.resources[0]).toMatchObject({
    id: 42,
    device_key: 'route-key',
    app_device_id: 'app-key',
  })
  expect(payload.grants).toEqual(payload.resources)
  expect(payload.projectId).toBe('project')
  expect(JSON.stringify(output.mock.calls)).not.toContain(secret)
})

test('preserves the scenario failure if diagnostic collection fails', async () => {
  const output = vi.spyOn(console, 'error').mockImplementation(() => {})
  const secret = 'response-body-must-not-be-logged'
  const request = async () => {
    throw new Error(secret)
  }

  await expect(
    logTemplateRoutingFailure({ control: { command: request }, request })
  ).resolves.toBeUndefined()

  expect(JSON.parse(output.mock.calls[0][1])).toEqual({ errorType: 'Error' })
  expect(JSON.stringify(output.mock.calls)).not.toContain(secret)
})
