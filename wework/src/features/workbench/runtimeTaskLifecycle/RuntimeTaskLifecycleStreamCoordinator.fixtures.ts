import { afterEach } from 'vitest'
import { createRuntimeTaskLifecycleStream } from './runtimeTaskLifecycleStream'
import type { WorkbenchServices } from '../workbenchServices'
import type { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'
import type { RuntimeTranscriptResponse, RuntimeWorkListResponse } from '@/types/api'

export function runtimeTaskAddress() {
  return {
    deviceId: 'remote-device',
    taskId: 'claude-task',
    runtime: 'claude_code' as const,
    workspacePath: '/workspace',
  }
}

export function runtimeWork(running: boolean, remoteHostId?: string): RuntimeWorkListResponse {
  const address = runtimeTaskAddress()
  return {
    projects: [],
    chats: [
      {
        deviceId: address.deviceId,
        ...(remoteHostId ? { remoteHostId } : {}),
        workspacePath: address.workspacePath,
        available: true,
        tasks: [
          {
            taskId: address.taskId,
            workspacePath: address.workspacePath,
            title: 'Claude task',
            runtime: address.runtime,
            running,
            status: running ? 'active' : 'done',
            ...(running ? {} : { completedAt: 1_786_692_066_192 }),
          },
        ],
      },
    ],
    totalTasks: 1,
  }
}

export function runtimeTranscript(running: boolean): RuntimeTranscriptResponse {
  const address = runtimeTaskAddress()
  return {
    taskId: address.taskId,
    workspacePath: address.workspacePath,
    runtime: address.runtime,
    running,
    messages: [],
    turns: [
      {
        id: 'turn-1',
        status: 'completed',
        items: [
          {
            id: 'user-1',
            type: 'user_message',
            message: {
              id: 'user-1',
              role: 'user',
              content: '之前的请求',
              status: 'done',
              createdAt: '2026-08-21T00:00:00.000Z',
            },
          },
          {
            id: 'assistant-1',
            type: 'assistant_text',
            content: '已恢复的 AI 输出',
            createdAt: '2026-08-21T00:00:00.500Z',
          },
        ],
      },
    ],
  }
}

const lifecycleOwners = new Set<ReturnType<typeof createRuntimeTaskLifecycleStream>>()
afterEach(() => {
  for (const owner of lifecycleOwners) owner.disconnect()
  lifecycleOwners.clear()
})

export function renderRuntimeTaskLifecycle(input: {
  services: WorkbenchServices
  store: RuntimeTaskLifecycleStore
}) {
  let current = input.store
  let owner = createRuntimeTaskLifecycleStream(current)
  lifecycleOwners.add(owner)
  owner.observe(input.services)
  return {
    unmount: () => owner.disconnect(),
    rerender(next: typeof input) {
      if (next.store !== current) {
        owner.disconnect()
        lifecycleOwners.delete(owner)
        current = next.store
        owner = createRuntimeTaskLifecycleStream(current)
        lifecycleOwners.add(owner)
      }
      owner.observe(next.services)
    },
  }
}
