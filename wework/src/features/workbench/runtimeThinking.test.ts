import { describe, expect, test } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import { getLatestRuntimeLiveActivity } from './runtimeThinking'

describe('runtimeThinking', () => {
  test('projects the latest process text separately from private thinking', () => {
    const message: WorkbenchMessage = {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      status: 'streaming',
      createdAt: '2026-09-09T00:00:00Z',
      streamingThinkingContent: 'Private chain of thought',
      blocks: [
        {
          id: 'process-1',
          subtaskId: 'turn-1',
          type: 'text',
          content: '先定位卡片的数据来源。',
          status: 'done',
          createdAt: 1,
        },
        {
          id: 'tool-1',
          subtaskId: 'turn-1',
          type: 'tool',
          toolName: 'functions.exec_command',
          toolInput: { cmd: 'pnpm test' },
          status: 'streaming',
          createdAt: 2,
        },
      ],
    }

    const activity = getLatestRuntimeLiveActivity([message])

    expect(activity.thinking).toBe('Private chain of thought')
    expect(activity.processText).toBe('先定位卡片的数据来源。')
  })

  test('bounds tool history and large tool inputs in live activity', () => {
    const message: WorkbenchMessage = {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      status: 'streaming',
      createdAt: '2026-09-11T00:00:00Z',
      blocks: Array.from({ length: 5 }, (_, index) => ({
        id: `tool-${index}`,
        subtaskId: 'turn-1',
        type: 'tool' as const,
        toolName: 'functions.apply_patch',
        toolInput: {
          patch: `${index}:${'x'.repeat(10_000)}`,
          unrelatedPayload: 'y'.repeat(10_000),
        },
        status: 'done' as const,
        createdAt: index,
      })),
    }

    const activity = getLatestRuntimeLiveActivity([message])

    expect(activity.tools.map(tool => tool.id)).toEqual(['tool-2', 'tool-3', 'tool-4'])
    expect(activity.tools[0]?.toolInput?.patch).toHaveLength(2_048)
    expect(activity.tools[0]?.toolInput).not.toHaveProperty('unrelatedPayload')
    expect(JSON.stringify(activity).length).toBeLessThan(7_000)
  })
})
