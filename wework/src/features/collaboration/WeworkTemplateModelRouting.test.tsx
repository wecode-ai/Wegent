import { expect, it, vi } from 'vitest'
import {
  agentDefinitionRouting,
  resolveRunnerSelection,
  runnerModelKey,
  type RunnerEnvironment,
  type RunnerModel,
} from '@wegent/collaboration'
import { createWeworkProjectAgentConfigurationHost } from './WeworkProjectAgentConfigurationHost'

const model: RunnerModel = {
  runtime: 'codex',
  provider: 'company',
  model_id: 'model',
  source: 'native',
  label: 'Model',
  account_label: 'Company',
  local_model_id: 'model',
  is_default: false,
}

function fixture() {
  const local = {
    listRunnerEnvironments: vi.fn(async () => [
      {
        id: 'device',
        device_key: 'device',
        models: [model],
        runtimes: ['codex'],
      },
    ]),
    listModels: vi.fn(async () => []),
  }
  const host = createWeworkProjectAgentConfigurationHost(
    undefined,
    local as unknown as Parameters<typeof createWeworkProjectAgentConfigurationHost>[1]
  )
  return { host, local }
}

it('lists non-default models and uses the explicit selection without a device default', async () => {
  const { host } = fixture()
  expect(await host.listTemplateAgentModels!('codex')).toEqual({
    models: [model],
  })
  expect(agentDefinitionRouting('device', model)).toEqual({
    executionPolicy: { mode: 'fixed', environment_id: 'device' },
    modelPolicy: {
      mode: 'fixed',
      model: {
        runtime: 'codex',
        provider: 'company',
        model_id: 'model',
        source: 'native',
      },
    },
  })
})

it('rejects a removed model and incompatible runtime when a task actually runs', async () => {
  const { host, local } = fixture()
  local.listRunnerEnvironments.mockResolvedValue([
    { id: 'device', device_key: 'device', models: [], runtimes: ['codex'] },
  ])
  expect(await host.listTemplateAgentModels!('codex')).toEqual({ models: [] })
  const environments = (await local.listRunnerEnvironments()) as RunnerEnvironment[]
  const routing = agentDefinitionRouting('device', model)
  expect(() => resolveRunnerSelection({ environments, runtime: 'codex', ...routing })).toThrow(
    'RUNNER_MODEL_UNAVAILABLE'
  )
  expect(() =>
    resolveRunnerSelection({ environments, runtime: 'claude_code', ...routing })
  ).toThrow('RUNNER_RUNTIME_MISMATCH')
})

it('lists compatible cloud models and rejects a cloud model removed after selection', async () => {
  const { host, local } = fixture()
  const cloud = {
    name: 'cloud',
    type: 'user',
    namespace: 'default',
    resourceUserId: 7,
    modelId: 'upstream',
    provider: 'openai',
    config: { protocol: 'openai', modelConfig: { model_id: 'upstream' } },
  }
  local.listModels.mockResolvedValue([cloud] as never)
  const models = await host.listTemplateCloudAgentModels!('codex')
  const selected = models.find(item => item.source === 'cloud')
  expect(selected).toBeDefined()
  expect(new Set(models.map(runnerModelKey)).size).toBe(models.length)
  expect(agentDefinitionRouting('device', selected).modelPolicy).toMatchObject({
    mode: 'fixed',
    model: { source: 'cloud', cloud_model: { name: 'cloud', resource_user_id: 7 } },
  })
  local.listModels.mockResolvedValue([])
  expect(await host.listTemplateCloudAgentModels!('codex')).toEqual([])
  expect(() =>
    resolveRunnerSelection({
      environments: [{ id: 'device', models: [model], runtimes: ['codex'] } as RunnerEnvironment],
      cloudModels: [],
      runtime: 'codex',
      executionPolicy: { mode: 'fixed', environment_id: 'device' },
      modelPolicy: { mode: 'user_select' },
      selection: { model: selected },
    })
  ).toThrow('RUNNER_MODEL_UNAVAILABLE')
})

it('loads native choices independently and exposes cloud catalog failures', async () => {
  const { host, local } = fixture()
  local.listModels.mockRejectedValue(new Error('Cloud connection unavailable'))
  expect(await host.listTemplateAgentModels!('codex')).toEqual({
    models: [model],
  })
  await expect(host.listTemplateCloudAgentModels!('codex')).rejects.toThrow(
    'Cloud connection unavailable'
  )
})

it('does not wait for a pending cloud catalog before exposing native choices', async () => {
  const { host, local } = fixture()
  local.listModels.mockImplementation(() => new Promise(() => {}))
  void host.listTemplateCloudAgentModels!('codex')
  expect(await host.listTemplateAgentModels!('codex')).toEqual({ models: [model] })
})
