import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import type { RunnerEnvironment, RunnerModel } from '@wegent/collaboration'
import { useAgentRouting } from './useAgentRouting'

const model: RunnerModel = {
  runtime: 'codex',
  provider: 'openai',
  model_id: 'a',
  label: 'A',
  local_model_id: 'a',
  account_label: 'Personal account',
  is_default: true,
}
const environment = (id: string, models: RunnerModel[]): RunnerEnvironment => ({
  id,
  name: id,
  device_key: id,
  owner_type: 'user',
  owner_id: '1',
  status: 'online',
  project_authorized: true,
  models,
})

describe('agent routing editor', () => {
  test('keeps an invalid model visible after changing environment until explicitly replaced', async () => {
    const api = {
      listModels: async () => [],
      listRunnerEnvironments: async () => [
        environment('1', [model]),
        environment('2', [{ ...model, model_id: 'b' }]),
      ],
    }
    const { result } = renderHook(() => useAgentRouting(api, 'codex', 'project'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.models).toEqual([])
    act(() => result.current.load({ mode: 'fixed', environment_id: '1' }, { mode: 'fixed', model }))
    expect(result.current.valid).toBe(true)
    act(() => result.current.setExecutionPolicy({ mode: 'fixed', environment_id: '2' }))
    expect(result.current.model?.model_id).toBe('a')
    expect(result.current.modelAvailable).toBe(false)
    expect(result.current.valid).toBe(false)
    act(() => result.current.setModel({ runtime: 'codex', provider: 'openai', model_id: 'b' }))
    expect(result.current.valid).toBe(true)
  })
})
