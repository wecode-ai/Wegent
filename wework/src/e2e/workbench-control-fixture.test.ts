// @vitest-environment node

import { afterEach, expect, test, vi } from 'vitest'
import { Readable } from 'node:stream'
import {
  createComposerDocument,
  serializeComposerDocument,
} from '@wegent/collaboration/composer/composerProseMirrorModel'
import { createDesktopScenario } from '../../e2e/desktop/scenarios/workbench-control.scenario.mjs'
import { CLOUD_DEVICE_ID } from '../../e2e/desktop/modules/shared.mjs'
import { waitForScenarioProgress } from '../../e2e/desktop/modules/scenario-progress.mjs'

const SOURCE_DEVICE = {
  device_type: 'local',
  device_id: 'electron-source-device',
  runtime_instance_id: 'source-runtime-instance',
}
const APP_DEVICE = {
  device_type: 'app',
  device_id: 'persisted-app-device-uuid',
  execution_target_id: 'app-record-1',
  app_device_id: SOURCE_DEVICE.device_id,
  runtime_instance_id: SOURCE_DEVICE.runtime_instance_id,
}
const SOURCE_SNAPSHOT = JSON.stringify({
  workbench: {
    currentRuntimeTask: { deviceId: SOURCE_DEVICE.device_id, taskId: 'source-task' },
    devices: [SOURCE_DEVICE],
  },
})

vi.mock('../../e2e/desktop/modules/cloud-environment.mjs', () => ({
  verifyLocalExecutorUsesCloudSocketUrl: vi.fn(),
}))

vi.mock('../../e2e/desktop/modules/shared.mjs', async importOriginal => ({
  ...(await importOriginal<typeof import('../../e2e/desktop/modules/shared.mjs')>()),
  selectE2EModel: vi.fn(),
}))

vi.mock('../../e2e/desktop/modules/scenario-progress.mjs', () => ({
  waitForScenarioProgress: vi.fn(),
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

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

async function prepareFixture({
  waitError,
  role = 'executor',
  modelResponseTimeoutMs = 180000,
  appDevices = [APP_DEVICE],
}: {
  waitError?: Error
  role?: string
  modelResponseTimeoutMs?: number
  appDevices?: (typeof APP_DEVICE)[]
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
  const uploads: File[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      const path = new URL(url).pathname
      if (options?.body instanceof FormData) {
        expect(path).toBe('/api/attachments/upload')
        expect(options.headers).toEqual({ Authorization: 'Bearer synthetic' })
        const file = options.body.get('file') as File
        expect(file.name).toBe('control-resource.txt')
        expect(file.type).toBe('text/plain')
        expect(await file.text()).toBe('WEWORK_CONTROL_RESOURCE_CONTENT_E2E')
        uploads.push(file)
        return new Response(JSON.stringify({ id: 91, status: 'ready' }), { status: 200 })
      }
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
  const environment = {
    ...restContext,
    workspacePath,
    waitForRuntimeTask,
    devices: vi.fn(async () => appDevices),
  }
  const scenario = createDesktopScenario({ uiTimeoutMs: 1000, modelResponseTimeoutMs })
  await scenario.prepareCloud(restContext)
  scenario.setCloudEnvironment(environment)
  return {
    workspacePath,
    requests,
    uploads,
    environment,
    restContext,
    scenario,
    waitForRuntimeTask,
  }
}

test('control fixture uploads an owned text resource through the existing multipart API', async () => {
  const { scenario, uploads } = await prepareFixture({})
  try {
    expect(uploads).toHaveLength(1)
    expect(await uploads[0].text()).toBe('WEWORK_CONTROL_RESOURCE_CONTENT_E2E')
  } finally {
    await scenario.cleanup()
  }
})

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

test('control model recognizes the source message after real composer link serialization', async () => {
  const { scenario } = await prepareFixture({})
  const reachedUi = new Error('Reached the UI')
  await expect(
    scenario.verify({
      command: vi.fn(async () => {
        throw reachedUi
      }),
    })
  ).rejects.toBe(reachedUi)
  const url = 'https://github.com/synthetic/control-e2e/pull/43'
  const prompt = `WEWORK_CONTROL_SOURCE_E2E: this conversation owns ${url}`
  const text = serializeComposerDocument(createComposerDocument(prompt))
  expect(text).toContain(`[synthetic/control-e2e#43](${url})`)
  const request = Object.assign(
    Readable.from([JSON.stringify({ input: [{ role: 'user', content: text }] })]),
    { method: 'POST' }
  )
  const response = { writeHead: vi.fn(), end: vi.fn() }
  try {
    expect(
      await scenario.handleHttp(request, response, new URL('http://model.test/responses'))
    ).toBe(true)
    expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
    expect(response.end.mock.calls[0][0]).toContain('WEWORK_CONTROL_SOURCE_READY')
  } finally {
    await scenario.cleanup()
  }
})

test('control workflow uses the runner model-response budget instead of the UI-action budget', async () => {
  const modelResponseTimeoutMs = 98765
  const { scenario } = await prepareFixture({ modelResponseTimeoutMs })
  const reachedWorkflowWait = new Error('Reached the complete workflow wait')
  const command = vi.fn(
    async (action: string, _selector: string, options?: { text?: string; timeoutMs?: number }) => {
      if (action === 'getWorkbenchDebugSnapshot') return SOURCE_SNAPSHOT
      if (action === 'waitFor' && options?.text === 'WEWORK_CONTROL_COMPLETE') {
        expect(options.timeoutMs).toBe(modelResponseTimeoutMs)
        throw reachedWorkflowWait
      }
    }
  )
  try {
    await expect(scenario.verify({ command })).rejects.toBe(reachedWorkflowWait)
    expect(waitForScenarioProgress).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Function),
      expect.any(Number),
      modelResponseTimeoutMs
    )
  } finally {
    await scenario.cleanup()
  }
})

test.each(['ready', 'preparing', 'failed', 'cancelled', 'wrong-workspace', 'owner-unavailable'])(
  'local APP conversation continuation waits for its owning Executor: %s',
  async state => {
    const { scenario, waitForRuntimeTask } = await prepareFixture({})
    const reachedWorkflow = new Error('Reached workflow wait')
    let settled = state !== 'preparing'
    const localRead = vi.fn(async () => {
      if (state === 'owner-unavailable') throw new Error('Owning Executor is unavailable')
      return JSON.stringify({
        workspaces: [
          {
            workspacePath: '/cloud-workspace',
            tasks: [
              {
                taskId: 'cloud-task',
                workspacePath:
                  state === 'wrong-workspace' ? '/another-workspace' : '/cloud-workspace',
                threadId: 'local-native-thread',
                running: !settled,
                status: ['failed', 'cancelled'].includes(state)
                  ? state
                  : settled
                    ? 'done'
                    : 'running',
              },
            ],
          },
        ],
      })
    })
    await expect(
      scenario.verify({
        command: vi.fn(async (action: string, _selector: string, options?: { text?: string }) => {
          if (action === 'getWorkbenchDebugSnapshot') return SOURCE_SNAPSHOT
          if (action === 'getLocalRuntimeWork') return localRead()
          if (options?.text === 'WEWORK_CONTROL_COMPLETE') throw reachedWorkflow
        }),
      })
    ).rejects.toBe(reachedWorkflow)
    const sourceId = `conv_${Buffer.from(JSON.stringify([SOURCE_DEVICE.device_id, 'source-task'])).toString('base64url')}`
    const answers = [
      { conversation_id: 'controller' },
      { conversation_id: sourceId },
      'WEWORK_CONTROL_SOURCE_E2E https://github.com/synthetic/control-e2e/pull/43',
      {},
      { resolution: 'unique' },
      { operation: { delivery_status: 'accepted', operation_id: 'op' }, duplicate: false },
      { duplicate: true },
      { operation_id: 'op' },
      { id: 'rule', name: 'Control CI every five minutes', enabled: false },
      { id: 'rule' },
      {},
      { properties: { options: { properties: { initialGoal: {} } } } },
      { accepted: true, conversation_id: 'created', taskId: 'created-task' },
      {
        conversation_id: 'created',
        model_selection: {
          options: { reasoning: 'high', permissionMode: 'read-only', collaborationMode: 'plan' },
        },
      },
    ]
    const respond = (stage: number, output: unknown) => {
      const request = Object.assign(
        Readable.from([
          JSON.stringify({
            tools: [{ type: 'function', name: 'mcp__wework_control__invoke_capability' }],
            input: [
              { role: 'user', content: 'WEWORK_CONTROL_CONTROLLER_E2E' },
              {
                type: 'function_call_output',
                call_id: `control-step-${stage}`,
                output: JSON.stringify(output),
              },
            ],
          }),
        ]),
        { method: 'POST' }
      )
      const response = { writeHead: vi.fn(), end: vi.fn() }
      return {
        response,
        done: scenario.handleHttp(request, response, new URL('http://model.test/responses')),
      }
    }
    try {
      for (const [index, answer] of answers.entries()) {
        const call = respond(index, answer)
        await call.done
        expect(call.response.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      }
      waitForRuntimeTask.mockImplementationOnce(async () => {
        throw new Error('Cloud runtime lists do not contain local APP tasks')
      })
      const call = respond(14, {
        accepted: true,
        conversation_id: 'cloud-created',
        deviceId: SOURCE_DEVICE.device_id,
        taskId: 'cloud-task',
        workspacePath: '/cloud-workspace',
      })
      await vi.waitFor(() => expect(localRead).toHaveBeenCalled())
      if (state === 'preparing') {
        expect(call.response.end).not.toHaveBeenCalled()
        settled = true
      }
      await call.done
      expect(waitForRuntimeTask).toHaveBeenCalledTimes(1)
      if (['failed', 'cancelled', 'wrong-workspace', 'owner-unavailable'].includes(state)) {
        expect(call.response.writeHead).toHaveBeenCalledWith(500)
        expect(call.response.end.mock.calls[0][0]).not.toContain('continue_conversation')
      } else {
        expect(call.response.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
        expect(call.response.end.mock.calls[0][0]).toContain('continue_conversation')
        expect(call.response.end.mock.calls[0][0]).toContain('cloud-created')
      }
    } finally {
      await scenario.cleanup()
    }
  }
)

test.each([
  ['remote device', [{ ...APP_DEVICE, device_type: 'remote' }]],
  ['another physical app', [{ ...APP_DEVICE, app_device_id: 'electron-other-device' }]],
  ['another runtime', [{ ...APP_DEVICE, runtime_instance_id: 'other-runtime-instance' }]],
  ['ambiguous registration', [APP_DEVICE, { ...APP_DEVICE, device_id: 'duplicate-app-uuid' }]],
])('control fixture rejects %s as proof of the local APP source', async (_name, appDevices) => {
  const { scenario } = await prepareFixture({ appDevices })
  const command = vi.fn(async (action: string) => {
    if (action === 'getWorkbenchDebugSnapshot') return SOURCE_SNAPSHOT
  })
  try {
    await expect(scenario.verify({ command })).rejects.toThrow(/real APP device/)
    expect(waitForScenarioProgress).not.toHaveBeenCalled()
  } finally {
    await scenario.cleanup()
  }
})
