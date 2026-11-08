// @vitest-environment node

import { describe, expect, test } from 'vitest'
import { getWorkbenchPaneKey, resolveRuntimeWorkbenchPane } from './workbenchPaneIdentity'
import { qualifyLocalRuntimeWork } from '@/lib/local-runtime-sidebar-identity'
import type { RuntimeWorkListResponse } from '@/types/api'

describe('getWorkbenchPaneKey', () => {
  test('keys runtime panes by stable task identity', () => {
    expect(
      getWorkbenchPaneKey({
        currentRuntimeTask: {
          deviceId: 'device-1',
          taskId: 'task-1',
          workspacePath: '/workspace/one',
        },
        currentProject: null,
      })
    ).toBe('runtime:device-1:task-1')
  })

  test('gives each blank conversation its own mount identity', () => {
    expect(
      getWorkbenchPaneKey({
        currentRuntimeTask: null,
        currentProject: null,
        standaloneChatKey: 7,
      })
    ).toBe('blank:7')
  })
})

describe('resolveRuntimeWorkbenchPane', () => {
  const work: RuntimeWorkListResponse = {
    projects: [],
    chats: [
      {
        deviceId: 'current-local-device',
        available: true,
        workspacePath: '/repo',
        tasks: [
          { taskId: 'task-1', title: 'Local task', runtime: 'codex', workspacePath: '/repo' },
        ],
      },
    ],
    totalTasks: 1,
  }
  const localWork = () =>
    qualifyLocalRuntimeWork(work, {
      deviceId: 'current-local-device',
      runtimeInstanceId: 'current-runtime',
      provenance: 'local-ipc',
    })

  test('restores a locally owned task independently of the saved device identity', () => {
    const current = localWork()
    const before = JSON.stringify(current)
    expect(
      resolveRuntimeWorkbenchPane(current, 'runtime:previous-device:task-1')?.currentRuntimeTask
    ).toMatchObject({ deviceId: 'current-local-device', taskId: 'task-1', workspacePath: '/repo' })
    expect(JSON.stringify(current)).toBe(before)
  })

  test('does not infer local ownership from untrusted serialized work', () => {
    expect(resolveRuntimeWorkbenchPane(work, 'runtime:previous-device:task-1')).toBeNull()
    expect(
      resolveRuntimeWorkbenchPane(
        JSON.parse(JSON.stringify(localWork())),
        'runtime:previous-device:task-1'
      )
    ).toBeNull()
  })

  test('keeps remote task ownership when task IDs coincide', () => {
    const current = localWork()
    current.chats.push({
      ...work.chats[0],
      deviceId: 'remote-device',
      remoteHostId: 'remote-host',
      workspaceSource: 'remote',
    })
    expect(
      resolveRuntimeWorkbenchPane(current, 'runtime:remote-device:task-1')?.currentRuntimeTask
        ?.deviceId
    ).toBe('remote-device')
  })

  test('does not redirect a known remote owner to a local task', () => {
    const current = localWork()
    current.chats.push({ ...work.chats[0], deviceId: 'remote-device', tasks: [] })
    expect(resolveRuntimeWorkbenchPane(current, 'runtime:remote-device:task-1')).toBeNull()
  })

  test('keeps offline remote ownership even without a loaded remote workspace', () => {
    expect(
      resolveRuntimeWorkbenchPane(localWork(), 'runtime:offline-device:task-1', [
        { device_id: 'offline-device' },
      ])
    ).toBeNull()
  })

  test('rejects ambiguous local task owners', () => {
    const current = localWork()
    const other = qualifyLocalRuntimeWork(
      { ...work, chats: [{ ...work.chats[0], deviceId: 'other' }] },
      {
        deviceId: 'other',
        runtimeInstanceId: 'other-runtime',
        provenance: 'local-ipc',
      }
    )
    current.chats.push(...other.chats)
    expect(resolveRuntimeWorkbenchPane(current, 'runtime:previous-device:task-1')).toBeNull()
  })
})
