// @vitest-environment node

import { afterEach, expect, test, vi } from 'vitest'
import { createDesktopScenario } from '../../e2e/desktop/scenarios/workbench-control.scenario.mjs'
import { CLOUD_DEVICE_ID } from '../../e2e/desktop/modules/shared.mjs'

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

async function prepareFixture({
  waitError,
  role = 'executor',
}: {
  waitError?: Error
  role?: string
}) {
  const workspacePath = '/fixture/exact-remote-workspace'
  const origin = {
    type: 'board_task',
    cloudProjectId: 'project',
    loopItemId: 'issue',
    dispatch_role: role,
  }
  const summary = {
    taskId: 'scoped-task',
    workspacePath,
    title: 'Scoped continuation',
    runtime: 'codex',
    status: 'completed',
  }
  const waitForRuntimeTask = vi.fn(async () => {
    if (waitError) throw waitError
    return summary
  })
  const requests: Array<{ path: string; body: Record<string, unknown> | undefined }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      const path = new URL(url).pathname
      requests.push({ path, body: options?.body ? JSON.parse(options.body as string) : undefined })
      let result: unknown
      if (path === '/api/runtime-work/create') {
        result = { accepted: true, deviceId: CLOUD_DEVICE_ID, ...summary }
      } else if (path === '/api/runtime-work/transcript') result = { ...summary, origin }
      else if (path === '/api/v1/workspaces') result = { id: 'workspace' }
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
  return { workspacePath, requests, environment, restContext, scenario, waitForRuntimeTask }
}

test('scoped control fixture uses the live environment address and waiter, not the REST setup context', async () => {
  const reachedRuntime = new Error('Reached the real runtime wait boundary')
  const fixture = await prepareFixture({ waitError: reachedRuntime })
  const { scenario, workspacePath, requests, waitForRuntimeTask, environment, restContext } =
    fixture
  await expect(scenario.verify({})).rejects.toBe(reachedRuntime)
  const creation = requests.find(request => request.path === '/api/runtime-work/create')?.body
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

test.each(['executor', 'viewer'])(
  'scoped control fixture verifies persisted %s identity through canonical context, not list internals',
  async role => {
    const { scenario, workspacePath, requests } = await prepareFixture({ role })
    const reachedUi = new Error('Reached the UI after checking persisted identity')
    const command = vi.fn(async () => {
      throw reachedUi
    })
    try {
      if (role === 'executor') await expect(scenario.verify({ command })).rejects.toBe(reachedUi)
      else {
        await expect(scenario.verify({ command })).rejects.toThrow(/viewer.*executor/s)
        expect(command).not.toHaveBeenCalled()
      }
      const creation = requests.find(request => request.path === '/api/runtime-work/create')?.body
      expect(
        requests.find(request => request.path === '/api/runtime-work/transcript')?.body
      ).toEqual({
        deviceId: creation?.deviceId,
        taskId: 'scoped-task',
        workspacePath,
        conversationContextOnly: true,
        limit: 1,
      })
    } finally {
      await scenario.cleanup()
    }
  }
)
