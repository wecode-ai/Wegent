import { describe, expect, it } from 'vitest'
import {
  cloudRunnerModels,
  policyModels,
  resolveRunnerSelection,
  runnerModelKey,
  type RunnerEnvironment,
} from './runnerRouting'

const cloudModels = cloudRunnerModels([
  {
    name: 'cloud-x',
    type: 'public',
    provider: 'openai',
    modelId: 'x',
    namespace: 'default',
    resourceUserId: 0,
    config: { protocol: 'openai-responses', api_key: 'must-not-be-copied' },
  },
])

const model = { runtime: 'codex' as const, provider: 'openai', model_id: 'x' }
const environment = (id: string, provider = 'openai'): RunnerEnvironment => ({
  id,
  device_key: id,
  name: id,
  owner_type: 'user',
  owner_id: '1',
  status: 'offline',
  project_authorized: true,
  models: [
    {
      ...model,
      provider,
      label: 'X',
      local_model_id: 'native-x',
      is_default: true,
      account_label: 'Runner account',
    },
  ],
})
const environments = [environment('a'), environment('b', 'other')]

describe('runner routing', () => {
  it('offers cloud models to both native runtimes through the executor protocol bridge', () => {
    expect(cloudModels.map(model => model.runtime)).toEqual(['codex', 'claude_code'])
    expect(JSON.stringify(cloudModels)).not.toContain('must-not-be-copied')
  })
  it('keeps native models distinct by stable provider identity', () => {
    const models = policyModels(environments, 'codex', { mode: 'fixed', environment_id: 'a' })
    expect(models).toHaveLength(1)
    expect(models[0].environments).toEqual(['a · Runner account'])
  })
  for (const mode of ['fixed', 'project_pool', 'user_select'] as const) {
    for (const modelMode of ['fixed', 'user_select'] as const) {
      it(`resolves ${mode}/${modelMode} even when the runner is offline`, () => {
        const result = resolveRunnerSelection({
          environments,
          runtime: 'codex',
          executionPolicy: mode === 'fixed' ? { mode, environment_id: 'a' } : { mode },
          modelPolicy: modelMode === 'fixed' ? { mode: modelMode, model } : { mode: modelMode },
          selection: {
            ...(mode === 'user_select'
              ? {
                  execution_policy: {
                    mode: 'fixed',
                    environment_id: 'a',
                  } as const,
                }
              : {}),
            ...(modelMode === 'user_select' ? { model } : {}),
          },
        })
        expect(result.candidates.map(item => item.id)).toEqual(['a'])
      })
    }
  }
  it('never moves a bound Issue when the personal default changes', () => {
    expect(
      resolveRunnerSelection({
        environments,
        runtime: 'codex',
        executionPolicy: { mode: 'user_select' },
        modelPolicy: { mode: 'fixed', model },
        boundEnvironmentId: 'a',
        defaultEnvironmentId: 'b',
      }).candidates[0].id
    ).toBe('a')
  })
  it('requires explicit choices for automation and for inconsistent pool defaults', () => {
    const input = {
      environments,
      runtime: 'codex' as const,
      executionPolicy: { mode: 'project_pool' } as const,
      modelPolicy: { mode: 'user_select' } as const,
    }
    expect(() => resolveRunnerSelection(input)).toThrow('RUNNER_MODEL_REQUIRED')
    expect(() =>
      resolveRunnerSelection({
        ...input,
        automatic: true,
        executionPolicy: { mode: 'user_select' },
        defaultEnvironmentId: 'a',
      })
    ).toThrow('AUTOMATION_RUNNER_REQUIRED')
    expect(() =>
      resolveRunnerSelection({
        ...input,
        environments: [environment('a'), environment('b')],
      })
    ).toThrow('RUNNER_MODEL_REQUIRED')
  })
  it('rejects an environment switch that no longer supports the fixed model', () => {
    expect(() =>
      resolveRunnerSelection({
        environments,
        runtime: 'codex',
        executionPolicy: { mode: 'fixed', environment_id: 'b' },
        modelPolicy: { mode: 'fixed', model },
      })
    ).toThrow('RUNNER_MODEL_UNAVAILABLE')
  })

  it('uses cloud catalogs for automatic and deferred policies, and adds fixed runner models', () => {
    expect(cloudModels).toHaveLength(2)
    for (const mode of ['project_pool', 'user_select'] as const) {
      expect(policyModels(environments, 'codex', { mode }, cloudModels)).toEqual(
        cloudModels
          .filter(item => item.runtime === 'codex')
          .map(item => ({ ...item, environments: [] }))
      )
    }
    const fixed = policyModels(
      environments,
      'codex',
      { mode: 'fixed', environment_id: 'a' },
      cloudModels
    )
    expect(fixed.map(item => item.source ?? 'native')).toEqual(['cloud', 'native'])
    expect(JSON.stringify(fixed)).not.toContain('must-not-be-copied')
    expect(runnerModelKey(fixed[0])).not.toBe(runnerModelKey(fixed[1]))
  })

  for (const mode of ['fixed', 'project_pool', 'user_select'] as const) {
    for (const modelMode of ['fixed', 'user_select'] as const) {
      it(`executes a cloud model for ${mode}/${modelMode} without native model configuration`, () => {
        const selectedModel = cloudModels[0]
        const result = resolveRunnerSelection({
          environments: [{ ...environment('a'), models: [], runtimes: ['codex'] }],
          cloudModels,
          runtime: 'codex',
          executionPolicy: mode === 'fixed' ? { mode, environment_id: 'a' } : { mode },
          modelPolicy:
            modelMode === 'fixed' ? { mode: modelMode, model: selectedModel } : { mode: modelMode },
          selection: {
            ...(mode === 'user_select'
              ? { execution_policy: { mode: 'fixed', environment_id: 'a' } as const }
              : {}),
            ...(modelMode === 'user_select' ? { model: selectedModel } : {}),
          },
        })
        expect(result.candidates.map(item => item.id)).toEqual(['a'])
        expect(result.model.source).toBe('cloud')
        expect(result.model.cloud_model?.resource_user_id).toBe(0)
        expect(result.model).not.toHaveProperty('config')
      })
    }
  }

  it('rejects removed cloud authorization and unsupported executor types', () => {
    const input = {
      environments,
      cloudModels,
      runtime: 'codex' as const,
      executionPolicy: { mode: 'project_pool' } as const,
      modelPolicy: { mode: 'fixed', model: cloudModels[0] } as const,
    }
    expect(() => resolveRunnerSelection({ ...input, cloudModels: [] })).toThrow(
      'RUNNER_MODEL_UNAVAILABLE'
    )
    expect(() =>
      resolveRunnerSelection({
        ...input,
        environments: [{ ...environment('a'), models: [], runtimes: ['claude_code'] }],
      })
    ).toThrow('RUNNER_MODEL_UNAVAILABLE')
  })
})
