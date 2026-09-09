import { describe, expect, test } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import {
  getLatestRuntimeLiveActivity,
  runtimeLiveActivityFromSnapshot,
  runtimeLiveActivitySnapshot,
} from './runtimeThinking'

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

    expect(activity.processText).toBe('先定位卡片的数据来源。')
    expect(activity.thinking).toBe('Private chain of thought')
  })

  test('round trips process text in the compact live-activity snapshot', () => {
    const activity = {
      active: true,
      processText: '正在运行聚焦测试。',
      thinking: '',
      tools: [],
    }

    expect(runtimeLiveActivityFromSnapshot(runtimeLiveActivitySnapshot(activity))).toEqual(activity)
  })
})
