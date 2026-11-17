import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useMobileModels } from './useMobileModels'
import { reasoningEfforts, resolvedReasoningEffort } from '@/domain/modelSelection'
import type { RuntimeApi } from '@/services/runtimeApi'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let renderer: ReactTestRenderer
afterEach(async () => {
  if (renderer) await act(() => renderer.unmount())
})

it('loads the selected computer catalog and reasoning before a task or model picker is opened', async () => {
  const load = vi.fn().mockResolvedValue({
    models: [
      {
        runtime: 'codex',
        provider: 'openai',
        model_id: 'future-device-model',
        local_model_id: 'future-device-model',
        label: 'Future model',
        is_default: true,
        default_reasoning_effort: 'medium',
        supported_reasoning_efforts: ['low', 'medium', 'high', 'ultra'],
      },
    ],
  })
  const api = { listNativeModels: load } as unknown as RuntimeApi
  let state!: ReturnType<typeof useMobileModels>
  function Harness() {
    state = useMobileModels({
      api,
      devices: [
        {
          id: 11,
          device_id: 'computer',
          name: 'Computer',
          status: 'online',
          device_type: 'app',
          bind_shell: 'claudecode',
        },
      ],
      address: null,
      selectedDeviceId: 'computer',
      cloudModels: [],
      backendIdentity: 'account',
      permissionMode: 'full-access',
    })
    return null
  }
  await act(() => {
    renderer = create(<Harness />)
  })
  expect(load).toHaveBeenCalledExactlyOnceWith(11, 'computer')
  expect(state.selectedModel?.name).toBe('future-device-model')
  expect(reasoningEfforts(state.selectedModel!)).toEqual(['low', 'medium', 'high', 'ultra'])
  expect(resolvedReasoningEffort(state.selectedModel, state.selectedModelOptions.reasoning)).toBe(
    'medium'
  )
})
