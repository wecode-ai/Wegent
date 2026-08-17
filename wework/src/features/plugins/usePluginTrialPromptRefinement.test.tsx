import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { RuntimeTaskStreamHandlers } from '@/features/workbench/runtimePaneMessages'
import { usePluginTrialPromptRefinement } from './usePluginTrialPromptRefinement'

const createEphemeralRuntimeTask = vi.fn()
const subscribeRuntimeTaskStream = vi.fn()
const cancelRuntimePaneTask = vi.fn()

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbenchPaneContext: () => ({
    createEphemeralRuntimeTask,
    subscribeRuntimeTaskStream,
    cancelRuntimePaneTask,
  }),
}))

describe('usePluginTrialPromptRefinement', () => {
  let streamHandlers: RuntimeTaskStreamHandlers | null

  beforeEach(() => {
    streamHandlers = null
    createEphemeralRuntimeTask.mockReset()
    subscribeRuntimeTaskStream.mockReset()
    cancelRuntimePaneTask.mockReset()
    subscribeRuntimeTaskStream.mockImplementation((_address, handlers) => {
      streamHandlers = handlers
      return vi.fn()
    })
    createEphemeralRuntimeTask.mockImplementation(async (_prompt, options) => {
      const address = {
        deviceId: 'local',
        taskId: 'ephemeral-refinement',
        workspacePath: '/workspace',
      }
      options?.onRuntimeTaskOptimisticOpen?.(address)
      return address
    })
  })

  test('runs a hidden refinement task and returns only the assistant task text', async () => {
    const source = {
      deviceId: 'local',
      taskId: 'active-task',
      workspacePath: '/workspace',
      threadId: 'thread-active',
    }
    const { result } = renderHook(() => usePluginTrialPromptRefinement({ source, project: null }))

    const refinement = result.current({
      pluginName: 'Documents',
      draft: 'Draft a memo',
      templates: [{ name: 'Project memo', path: 'project-memo' }],
    })

    expect(createEphemeralRuntimeTask).toHaveBeenCalledWith(
      expect.stringContaining('Plugin: Documents'),
      expect.objectContaining({ source })
    )

    await act(async () => {
      streamHandlers?.onMessageAction({
        type: 'assistant_done',
        content: '```text\nDraft a concise project memo for the launch.\n```',
      })
    })

    await expect(refinement).resolves.toBe('Draft a concise project memo for the launch.')
  })

  test('surfaces model failures for inline retry', async () => {
    const { result } = renderHook(() =>
      usePluginTrialPromptRefinement({ source: null, project: null })
    )
    const refinement = result.current({
      pluginName: 'Documents',
      draft: '',
      templates: [],
    })
    const rejection = expect(refinement).rejects.toThrow('Model unavailable')

    await act(async () => {
      streamHandlers?.onMessageAction({
        type: 'assistant_error',
        error: 'Model unavailable',
      })
    })

    await rejection
  })
})
