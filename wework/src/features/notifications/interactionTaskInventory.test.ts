// @vitest-environment node

import { expect, it, vi } from 'vitest'
import type { TaskSource } from './NotificationTaskSourceContext'
import { readInteractionTaskInventory } from './interactionTaskInventory'
import { interactionTask } from './runtimeInteractions.fixtures'
import { createRuntimeConversationApi } from '@wegent/chat-core/runtime-conversation-api'

it('discovers healthy local task requests when the cloud device catalog calls this device offline', async () => {
  const list = vi.fn(async ({ deviceId }) => ({
    localIssueQuestionsPending: deviceId === 'device',
    projects: [],
    chats: [{ ...interactionTask.workspace, deviceId, tasks: [interactionTask.task] }],
    totalTasks: 1,
  }))
  const inventory = await readInteractionTaskInventory({
    items: [],
    devices: [
      { device_id: 'device', status: 'offline' },
      { device_id: 'remote', status: 'online' },
    ],
    services: {
      getLocalRuntimeSidebarIdentity: async () => ({
        deviceId: 'device',
        runtimeInstanceId: 'local',
        provenance: 'local-ipc',
      }),
      runtimeWorkApi: { listRuntimeWork: list },
    },
  } as unknown as TaskSource)
  expect(list).toHaveBeenCalledWith({ pendingOnly: true, preferCached: true, deviceId: 'device' })
  expect(new Set(inventory.items.map(item => item.address.deviceId))).toEqual(
    new Set(['device', 'remote'])
  )
  expect(inventory.localDeviceIds).toEqual(new Set(['device', 'local']))
  expect(inventory.failedDevices.has('device')).toBe(false)
  expect(inventory.localIssueQuestionsPending).toBe(true)
})

it('scopes reminders to every alias of the current runtime', async () => {
  const inventory = await readInteractionTaskInventory({
    items: [],
    devices: [
      {
        device_id: 'app-record-65',
        status: 'online',
        runtime_instance_id: 'runtime-shared',
        app_device_id: 'app-local',
        socket_device_id: 'socket-local',
        runtime_routes: [
          {
            kind: 'cloud-relay',
            device_id: 'cloud-alias',
            runtime_device_id: 'cloud-runtime-alias',
            status: 'online',
          },
        ],
      },
      {
        device_id: 'other-device',
        status: 'online',
        runtime_instance_id: 'runtime-other',
      },
    ],
    services: {
      getLocalRuntimeSidebarIdentity: async () => ({
        deviceId: 'local-device',
        runtimeInstanceId: 'runtime-shared',
        provenance: 'local-ipc',
      }),
      runtimeWorkApi: {
        listRuntimeWork: async () => ({ projects: [], chats: [], totalTasks: 0 }),
      },
    },
  } as unknown as TaskSource)
  expect(inventory.localDeviceIds).toEqual(
    new Set([
      'local-device',
      'runtime-shared',
      'app-record-65',
      'app-local',
      'socket-local',
      'cloud-alias',
      'cloud-runtime-alias',
    ])
  )
  expect(inventory.localDeviceIds.has('other-device')).toBe(false)
})

it('discovers authorized device requests independently and isolates a failed device', async () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  const list = vi.fn(async ({ deviceId }) => {
    if (deviceId === 'unavailable')
      throw Object.assign(new Error('Device offline', { cause: new Error('Connection closed') }), {
        code: 'DEVICE_UNAVAILABLE',
        status: 503,
      })
    return {
      projects: [],
      chats: [{ ...interactionTask.workspace, deviceId, tasks: [interactionTask.task] }],
      totalTasks: 1,
    }
  })
  const source = {
    items: [],
    devices: [
      { device_id: 'device', status: 'online' },
      { device_id: 'remote', status: 'busy' },
      { device_id: 'unavailable', status: 'online' },
      { device_id: 'offline', status: 'offline' },
    ],
    services: { runtimeWorkApi: { listRuntimeWork: list } },
  } as unknown as TaskSource
  const inventory = await readInteractionTaskInventory(source)
  expect(new Set(inventory.items.map(item => item.address.deviceId))).toEqual(
    new Set(['device', 'remote'])
  )
  expect(inventory.failedDevices).toEqual(new Set(['unavailable', 'offline']))
  expect(inventory.failedRequests).toEqual(new Set(['unavailable']))
  expect(list).toHaveBeenCalledTimes(3)
  expect(list).toHaveBeenCalledWith({ pendingOnly: true, preferCached: true, deviceId: 'remote' })
  expect(log).toHaveBeenCalledWith(
    '[Wework] Runtime task create diagnostic',
    expect.stringContaining('"stage":"pending-interaction-load-failed"')
  )
  const entry = JSON.parse(
    log.mock.calls.find(
      ([, value]) => typeof value === 'string' && value.includes('pending-interaction-load-failed')
    )![1] as string
  )
  expect(entry).toMatchObject({
    operation: 'inventory',
    deviceId: 'unavailable',
    error: {
      name: 'Error',
      message: 'Device offline',
      stack: expect.any(String),
      code: 'DEVICE_UNAVAILABLE',
      status: '503',
      cause: 'Connection closed',
    },
  })
  log.mockRestore()
})

it('logs local identity failures without blocking device inventory discovery', async () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  const list = vi.fn().mockResolvedValue({ projects: [], chats: [], totalTasks: 0 })
  try {
    await readInteractionTaskInventory({
      items: [],
      services: {
        getLocalRuntimeSidebarIdentity: async () => {
          throw { message: 'IPC unavailable', code: 'IPC_CLOSED', request: 'private payload' }
        },
        runtimeWorkApi: { listRuntimeWork: list },
      },
    } as unknown as TaskSource)
    expect(list).toHaveBeenCalledWith({
      pendingOnly: true,
      preferCached: true,
      deviceId: undefined,
    })
    expect(log).toHaveBeenCalledWith(
      '[Wework] Runtime task create diagnostic',
      expect.stringContaining('"operation":"local-identity"')
    )
    const entry = JSON.parse(log.mock.calls[0][1] as string)
    expect(entry.error).toEqual({ message: 'IPC unavailable', code: 'IPC_CLOSED' })
    expect(JSON.stringify(log.mock.calls)).not.toContain('private payload')
  } finally {
    log.mockRestore()
  }
})

it('preserves per-device isolation through the canonical HTTP adapter', async () => {
  const get = vi.fn(async (path: string) => {
    const url = new URL(path, 'https://backend/api')
    expect(url.searchParams.get('pending_only')).toBe('true')
    const deviceId = url.searchParams.get('device_id')
    if (deviceId === 'unavailable') throw new Error('Remote device unavailable')
    expect(deviceId).toBe('device')
    return {
      projects: [],
      chats: [{ ...interactionTask.workspace, tasks: [interactionTask.task] }],
      totalTasks: 1,
    }
  })
  const api = createRuntimeConversationApi({
    get: get as Parameters<typeof createRuntimeConversationApi>[0]['get'],
    post: vi.fn(),
  })
  const result = await readInteractionTaskInventory({
    items: [],
    devices: [
      { device_id: 'device', status: 'online' },
      { device_id: 'unavailable', status: 'online' },
    ],
    services: { runtimeWorkApi: api },
  } as unknown as TaskSource)
  expect(result.items).toHaveLength(1)
  expect(result.failedDevices).toEqual(new Set(['unavailable']))
})
