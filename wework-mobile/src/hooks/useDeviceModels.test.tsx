import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { executionFields, continuationSelection } from '@/domain/modelSelection'
import type { RuntimeApi } from '@/services/runtimeApi'
import type { DeviceInfo, RunnerModel, UnifiedModel } from '@/types/runtime'
import { useDeviceModels } from './useDeviceModels'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const device = (id: number): DeviceInfo => ({
  id,
  device_id: `app-record-${id}`,
  name: `Computer ${id}`,
  device_type: 'app',
  bind_shell: 'claudecode',
  status: 'online',
})
const native: RunnerModel = {
  runtime: 'codex',
  provider: 'openai',
  model_id: 'gpt-6.1-sol',
  local_model_id: 'gpt-6.1-sol',
  label: 'GPT-6.1 Sol',
  account_label: 'ChatGPT',
  is_default: true,
  default_reasoning_effort: 'medium',
  supported_reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
}
const cloud: UnifiedModel = {
  name: 'same-cloud',
  type: 'public',
  provider: 'openai',
  namespace: 'default',
  resourceUserId: 0,
  config: { protocol: 'openai-responses' },
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('device-owned model catalogs', () => {
  let renderer: ReactTestRenderer
  let state: ReturnType<typeof useDeviceModels>
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
  })
  function setup(load = vi.fn().mockResolvedValue({ models: [native] })) {
    const api = { listNativeModels: load } as unknown as RuntimeApi
    function Harness({ id = 11 }: { id?: number }) {
      state = useDeviceModels(api, device(id), [cloud])
      return null
    }
    return { load, Harness }
  }

  it('loads lazily, coalesces reads, preserves explicit selection and sends native identity for create and continue', async () => {
    const pending = deferred<{ models: RunnerModel[] }>()
    const { load, Harness } = setup(vi.fn().mockReturnValue(pending.promise))
    await act(() => {
      renderer = create(<Harness />)
    })
    expect(load).not.toHaveBeenCalled()
    expect(state.models).toEqual([cloud])
    await act(() => {
      void state.loadModels()
      void state.loadModels()
    })
    expect(load).toHaveBeenCalledExactlyOnceWith(11)
    expect(state.modelsLoading).toBe(true)
    await act(() => {
      pending.resolve({ models: [native, { ...native, provider: 'other', is_default: false }] })
    })
    expect(state.modelsLoading).toBe(false)
    expect(state.models).toHaveLength(3)
    expect(state.selectedModel?.runtime?.provider).toBe('openai')
    await act(() => state.selectModel(state.models[1], { reasoning: 'xhigh' }))
    const fields = executionFields(state.selectedModel!, state.selectedModelOptions)
    expect(fields).toMatchObject({
      modelId: native.model_id,
      modelType: 'runtime',
      modelOptions: { runnerModelProvider: 'other', codexProviderId: 'other', reasoning: 'xhigh' },
    })
    expect(continuationSelection(fields)).toEqual({
      modelName: fields.modelId,
      modelType: 'runtime',
      options: fields.modelOptions,
    })
    await act(() => state.loadModels())
    expect(load).toHaveBeenCalledOnce()
    await act(() => state.selectModel(cloud))
    await act(() => state.loadModels(true))
    expect(state.selectedModel).toBe(cloud)
  })

  it('isolates late responses and model options when switching between two computers', async () => {
    const pending = deferred<{ models: RunnerModel[] }>()
    const { Harness } = setup(
      vi
        .fn()
        .mockImplementation(id => (id === 11 ? pending.promise : Promise.resolve({ models: [] })))
    )
    await act(() => {
      renderer = create(<Harness />)
    })
    await act(() => {
      void state.loadModels()
    })
    await act(() => renderer.update(<Harness id={12} />))
    await act(() => {
      pending.resolve({ models: [native] })
    })
    expect(state.models).toEqual([cloud])
    expect(state.selectedModel).toBe(cloud)
    await act(() => renderer.update(<Harness />))
    expect(state.selectedModel?.name).toBe(native.model_id)
    await act(() => state.selectModel(state.selectedModel!, { reasoning: 'xhigh' }))
    await act(() => renderer.update(<Harness id={12} />))
    expect(state.selectedModelOptions).not.toHaveProperty('reasoning', 'xhigh')
    await act(() => renderer.update(<Harness />))
    expect(state.selectedModelOptions.reasoning).toBe('xhigh')
  })

  it('exposes failed discovery without blocking cloud selection and retries explicitly', async () => {
    const { Harness } = setup(
      vi
        .fn()
        .mockRejectedValueOnce(new Error('catalog denied'))
        .mockResolvedValue({ models: [native], catalog_error: null })
    )
    await act(() => {
      renderer = create(<Harness />)
    })
    await act(() => state.loadModels())
    expect(state.modelsError).toBe('catalog denied')
    expect(state.modelsLoading).toBe(false)
    expect(state.selectedModel).toBe(cloud)
    await act(() => state.loadModels(true))
    expect(state.modelsError).toBeNull()
    expect(state.selectedModel?.name).toBe(native.model_id)
  })

  it('keeps same-name cloud owners distinct and retains a native selection through background cloud refresh', async () => {
    const api = {
      listNativeModels: vi.fn().mockResolvedValue({ models: [native] }),
    } as unknown as RuntimeApi
    function Harness({ owner = 1 }: { owner?: number }) {
      state = useDeviceModels(api, device(11), [{ ...cloud, type: 'user', resourceUserId: owner }])
      return null
    }
    await act(() => {
      renderer = create(<Harness />)
    })
    await act(() => state.loadModels())
    await act(() => state.selectModel(state.models[0], { reasoning: 'low' }))
    await act(() => renderer.update(<Harness owner={2} />))
    expect(state.selectedModel?.type).toBe('runtime')
    expect(state.selectedModelOptions.reasoning).toBe('low')
  })
})
