import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mocks, config, workFor, resetMobileRuntimeMocks } from './mobileRuntimeTestFixtures'
import { useMobileRuntime, type MobileRuntimeState } from './useMobileRuntime'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('PC task model synchronization', () => {
  let renderer: ReactTestRenderer
  let state: MobileRuntimeState
  function Harness() {
    state = useMobileRuntime(config, 7)
    return null
  }
  beforeEach(resetMobileRuntimeMocks)
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
  })
  async function mount() {
    await act(() => {
      renderer = create(<Harness />)
    })
    expect(state.selectedModel?.name).toBe('public-model')
    await act(() => state.startNewConversation())
  }

  it.each(['ready', 'failed'] as const)(
    'continues the PC GPT task instead of the cloud default when its catalog is %s',
    async catalogState => {
      const selection = {
        modelName: 'gpt-6.1-sol',
        modelType: 'runtime' as const,
        options: { runnerModelProvider: 'openai', reasoning: 'xhigh', speed: 'fast' },
      }
      const work = workFor('app-record-11')
      work.chats[0].tasks[0].modelSelection = selection
      work.chats[0].tasks[0].threadId = 'pc-native-thread'
      mocks.listWork.mockResolvedValue(work)
      if (catalogState === 'failed') mocks.nativeModels.mockRejectedValue(new Error('offline'))
      else
        mocks.nativeModels.mockResolvedValue({
          models: [
            {
              runtime: 'codex',
              provider: 'openai',
              model_id: selection.modelName,
              local_model_id: selection.modelName,
              label: 'GPT-6.1 Sol',
              is_default: false,
              supported_reasoning_efforts: ['high', 'xhigh'],
            },
          ],
        })
      await mount()
      await act(() => state.openConversation(state.conversations[0]!))
      expect(state.selectedModel?.name).toBe(selection.modelName)
      expect(state.selectedModelOptions).toEqual(selection.options)
      expect(state.currentAddress?.threadId).toBe('pc-native-thread')
      await act(async () => {
        expect(await state.send('Continue the PC task')).toBe(true)
      })
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'task', threadId: 'pc-native-thread' }),
        'Continue the PC task',
        'user-message-id',
        { ...selection, options: { ...selection.options, permissionMode: 'full-access' } },
        undefined
      )
    }
  )

  it('updates the active and reopened conversation from runtime model events without reading the work list', async () => {
    mocks.listWork.mockResolvedValue(workFor('app-record-11'))
    await mount()
    await act(() => state.openConversation(state.conversations[0]!))
    const selection = {
      modelName: 'pc-gpt',
      modelType: 'runtime' as const,
      options: { runnerModelProvider: 'pc-provider', reasoning: 'ultra' },
    }
    const lifecycle = mocks.lifecycleSubscribe.mock.calls.at(-1)![0]
    await act(() =>
      lifecycle(state.currentAddress!, {
        name: 'response.completed',
        payload: { modelSelection: selection },
      })
    )
    expect(state.selectedModel?.name).toBe('pc-gpt')
    expect(state.selectedModelOptions.reasoning).toBe('ultra')
    expect(mocks.listWork).toHaveBeenCalledTimes(1)
    await act(() => state.startNewConversation())
    expect(state.selectedModel?.name).toBe('public-model')
    await act(() => state.openConversation(state.conversations[0]!))
    expect(state.selectedModel?.name).toBe('pc-gpt')
    await act(() =>
      lifecycle(
        { deviceId: 'other-device', taskId: 'task' },
        {
          name: 'response.completed',
          payload: { modelSelection: { ...selection, modelName: 'wrong-device-model' } },
        }
      )
    )
    expect(state.selectedModel?.name).toBe('pc-gpt')
  })

  it('continues a loaded legacy task with an explicit automatic model like PC', async () => {
    const work = workFor('app-record-11')
    work.chats[0].tasks[0].modelSelection = null
    mocks.listWork.mockResolvedValue(work)
    await mount()
    await act(() => state.openConversation(state.conversations[0]!))
    expect(state.selectedModel?.name).toBe('public-model')
    await act(async () => {
      expect(await state.send('Continue legacy task')).toBe(true)
    })
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task' }),
      'Continue legacy task',
      'user-message-id',
      expect.objectContaining({ modelName: 'public-model', modelType: 'public' }),
      undefined
    )
  })
})
