import { expect, it, vi } from 'vitest'
import { runnerModelKey, type RunnerModel } from '@wegent/collaboration'
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
    cloudModelsUnavailable: false,
  })
  expect(
    await host.resolveTemplateAgentRouting!('codex', 'local', 'project', undefined, model)
  ).toEqual({
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

it('rejects a removed model and a selection for another runtime', async () => {
  const { host, local } = fixture()
  local.listRunnerEnvironments.mockResolvedValue([
    { id: 'device', device_key: 'device', models: [], runtimes: ['codex'] },
  ])
  await expect(
    host.resolveTemplateAgentRouting!('codex', 'local', undefined, undefined, model)
  ).rejects.toThrow('template_model_unavailable')
  await expect(
    host.resolveTemplateAgentRouting!('claude_code', 'local', undefined, undefined, model)
  ).rejects.toThrow('template_model_unavailable')
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
  const { models } = await host.listTemplateAgentModels!('codex')
  const selected = models.find(item => item.source === 'cloud')
  expect(selected).toBeDefined()
  expect(new Set(models.map(runnerModelKey)).size).toBe(models.length)
  expect(
    (await host.resolveTemplateAgentRouting!('codex', 'local', undefined, undefined, selected))
      .modelPolicy
  ).toMatchObject({
    mode: 'fixed',
    model: { source: 'cloud', cloud_model: { name: 'cloud', resource_user_id: 7 } },
  })
  local.listModels.mockResolvedValue([])
  await expect(
    host.resolveTemplateAgentRouting!('codex', 'local', undefined, undefined, selected)
  ).rejects.toThrow('template_model_unavailable')
})

it('preserves native model choices and reports a cloud catalog failure explicitly', async () => {
  const { host, local } = fixture()
  local.listModels.mockRejectedValue(new Error('Cloud connection unavailable'))
  expect(await host.listTemplateAgentModels!('codex')).toEqual({
    models: [model],
    cloudModelsUnavailable: true,
  })
})
