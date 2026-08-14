import { render, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { RuntimeWorkListResponse } from '@/types/api'
import type { WorkbenchServices } from '../workbenchServices'
import { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'
import { RuntimeTaskLifecycleStreamCoordinator } from './RuntimeTaskLifecycleStreamCoordinator'

describe('RuntimeTaskLifecycleStreamCoordinator', () => {
  test('reconciles canonical completion when the terminal stream event is missed', async () => {
    const store = new RuntimeTaskLifecycleStore('test')
    const address = {
      deviceId: 'remote-device',
      taskId: 'claude-task',
      runtime: 'claude_code' as const,
      workspacePath: '/workspace',
    }
    const runtimeWork: RuntimeWorkListResponse = {
      projects: [],
      chats: [
        {
          deviceId: address.deviceId,
          workspacePath: '/workspace',
          available: true,
          tasks: [
            {
              taskId: address.taskId,
              workspacePath: '/workspace',
              title: 'Claude task',
              runtime: 'claude_code',
              running: true,
              status: 'active',
            },
          ],
        },
      ],
      totalTasks: 1,
    }
    store.syncRuntimeWork(runtimeWork)
    store.sendRequested(address)
    store.sendAccepted(address)

    const services = {
      chatStream: {
        subscribe: vi.fn(() => vi.fn()),
      },
      executorClient: {
        runtime: {
          getRuntimeTranscript: vi.fn().mockResolvedValue({
            taskId: address.taskId,
            workspacePath: '/workspace',
            runtime: 'claude_code',
            running: false,
            messages: [],
            turns: [
              {
                id: 'claude-turn',
                items: [],
                status: 'completed',
                completedAt: 1_786_692_066_192,
              },
            ],
          }),
        },
      },
    } as unknown as WorkbenchServices

    render(<RuntimeTaskLifecycleStreamCoordinator services={services} store={store} />)

    await waitFor(() => {
      expect(store.getTask(address)?.task).toMatchObject({
        status: 'done',
        running: false,
        completedAt: 1_786_692_066_192,
      })
    })
    expect(store.getTask(address)?.execution.phase).toBe('idle')
    expect(store.getTask(address)?.turn.phase).toBe('idle')
    expect(store.getTask(address)?.derived.shouldShowSidebarRunning).toBe(false)
    expect(services.executorClient.runtime.getRuntimeTranscript).toHaveBeenCalledWith({
      ...address,
      limit: 1,
    })
    expect(services.chatStream.subscribe).not.toHaveBeenCalled()
  })
})
