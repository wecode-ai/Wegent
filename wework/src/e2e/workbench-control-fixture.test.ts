// @vitest-environment node

import { afterEach, expect, test, vi } from 'vitest'
import { createDesktopScenario } from '../../e2e/desktop/scenarios/workbench-control.scenario.mjs'

vi.mock('../../e2e/desktop/modules/cloud-environment.mjs', () => ({
  verifyLocalExecutorUsesCloudSocketUrl: vi.fn(),
}))

vi.mock('../../e2e/desktop/modules/transport-fault-proxy.mjs', () => ({
  TransportFaultProxy: class {
    url = 'http://rest-only.test'
    async start() {
      return this
    }
    disconnectWebSockets() {}
    async stop() {}
  },
}))

afterEach(() => vi.unstubAllGlobals())

test('scoped control fixture uses the live environment address and waiter, not the REST setup context', async () => {
  const workspacePath = '/fixture/exact-remote-workspace'
  const reachedRuntime = new Error('Reached the real runtime wait boundary')
  const waitForRuntimeTask = vi.fn(async () => {
    throw reachedRuntime
  })
  let creation: Record<string, unknown> | undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      const path = new URL(url).pathname
      let result: unknown
      if (path === '/api/runtime-work/create') {
        creation = JSON.parse(options?.body as string)
        result = { accepted: true, taskId: 'scoped-task', workspacePath }
      } else if (path === '/api/v1/workspaces') result = { id: 'workspace' }
      else if (path === '/api/v1/cloud-projects') result = { id: 'project' }
      else if (path === '/api/teams') result = { items: [{ id: 'team' }] }
      else if (path === '/api/tasks/create') result = { id: 'cloud-history' }
      else if (path === '/api/v1/cloud-projects/project/loop-items') result = { id: 'issue' }
      else if (path === '/api/admin/setup-complete') result = {}
      else throw new Error(`Unexpected fixture request: ${url}`)
      return new Response(JSON.stringify(result), { status: 200 })
    })
  )
  const restContext = { backendUrl: 'http://backend.test', authToken: 'synthetic' }
  const environment = { ...restContext, workspacePath, waitForRuntimeTask }
  const scenario = createDesktopScenario({ uiTimeoutMs: 1000 })
  await scenario.prepareCloud(restContext)
  scenario.setCloudEnvironment(environment)
  await expect(scenario.verify({})).rejects.toBe(reachedRuntime)
  expect(creation).toMatchObject({
    workspacePath,
    cloudProjectId: 'project',
    origin: {
      type: 'board_task',
      cloudProjectId: 'project',
      loopItemId: 'issue',
      dispatch_role: 'executor',
    },
  })
  expect(waitForRuntimeTask).toHaveBeenCalledWith({
    deviceId: creation?.deviceId,
    taskId: 'scoped-task',
    workspacePath,
  })
  await scenario.cleanup()
  expect(environment.backendUrl).toBe(restContext.backendUrl)
})
