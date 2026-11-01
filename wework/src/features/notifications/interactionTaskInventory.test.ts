import { expect, it, vi } from 'vitest'
import type { TaskSource } from './NotificationTaskSourceContext'
import { readInteractionTaskInventory } from './interactionTaskInventory'
import { interactionTask } from './runtimeInteractions.fixtures'
import { createRuntimeConversationApi } from '@wegent/chat-core/runtime-conversation-api'

it('discovers authorized device requests independently and isolates a failed device', async () => {
  const list = vi.fn(async ({ deviceId }) => {
    if (deviceId === 'unavailable') throw new Error('Device offline')
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
  expect(list).toHaveBeenCalledTimes(3)
  expect(list).toHaveBeenCalledWith({ pendingOnly: true, deviceId: 'remote' })
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
