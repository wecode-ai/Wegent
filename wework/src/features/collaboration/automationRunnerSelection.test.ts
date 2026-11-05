import { describe, expect, it, vi } from 'vitest'
import {
  cloudRunnerModels,
  runnerModelIdentity,
  type CollaborationGroup,
  type RunnerEnvironment,
} from '@wegent/collaboration'
import type { UnifiedModel } from '@/types/api'
import { registerRunnerSelectionHandler } from '@/lib/runner-selection'
import {
  validateAutomationRunnerSelections,
  type AutomationRoutingRule,
  type AutomationRoutingTarget,
} from './automationRunnerSelection'

const cloudModels: UnifiedModel[] = [
  {
    name: 'cloud-test',
    type: 'public',
    provider: 'openai',
    modelId: 'test-model',
    namespace: 'default',
    resourceUserId: 0,
    config: { protocol: 'openai-responses' },
  } as UnifiedModel,
]
const model = runnerModelIdentity(cloudRunnerModels(cloudModels)[0])
const environments: RunnerEnvironment[] = [
  {
    id: 'device',
    device_key: 'device',
    name: 'Test device',
    owner_type: 'user',
    owner_id: '7',
    status: 'online',
    project_authorized: true,
    models: [
      {
        ...model,
        label: 'Test model',
        local_model_id: 'test-model',
        account_label: 'Test account',
        is_default: true,
      },
    ],
  },
]
const agent: AutomationRoutingTarget = {
  id: 'agent',
  runtime: 'codex',
  executionPolicy: { mode: 'user_select' },
  modelPolicy: { mode: 'user_select' },
}
const rule = (): AutomationRoutingRule => ({
  enabled: true,
  targetKind: 'agent',
  targetId: 'agent',
})

describe('automation runner policy shared by schedules and sources', () => {
  it('requests concrete unattended choices and persists them on the rule', async () => {
    const choose = vi
      .fn()
      .mockResolvedValue({ execution_policy: { mode: 'fixed', environment_id: 'device' }, model })
    const unregister = registerRunnerSelectionHandler(choose)
    try {
      const draft = rule()
      await validateAutomationRunnerSelections([agent], [], environments, async () => cloudModels, [
        draft,
      ])
      expect(choose).toHaveBeenCalledWith(
        expect.objectContaining({ automatic: true, runtime: 'codex' })
      )
      expect(draft.runnerSelection?.model).toEqual(model)
      await validateAutomationRunnerSelections([agent], [], environments, async () => cloudModels, [
        draft,
      ])
      expect(choose).toHaveBeenCalledTimes(1)
    } finally {
      unregister()
    }
  })
  it('preserves fixed member policies when another group member delegates model selection', async () => {
    const choose = vi
      .fn()
      .mockResolvedValue({ execution_policy: { mode: 'fixed', environment_id: 'device' }, model })
    const unregister = registerRunnerSelectionHandler(choose)
    const fixed: AutomationRoutingTarget = {
      ...agent,
      id: 'fixed',
      executionPolicy: { mode: 'project_pool' },
      modelPolicy: { mode: 'fixed', model },
    }
    const group = {
      id: 'group',
      leader: { kind: 'agent', id: 'agent' },
      members: [{ kind: 'agent', id: 'fixed' }],
    } as CollaborationGroup
    try {
      const draft = { ...rule(), targetKind: 'collaboration_group', targetId: 'group' }
      await validateAutomationRunnerSelections(
        [agent, fixed],
        [group],
        environments,
        async () => cloudModels,
        [draft]
      )
      expect(fixed.executionPolicy).toEqual({ mode: 'project_pool' })
      expect(choose).toHaveBeenCalledTimes(1)
    } finally {
      unregister()
    }
  })
  it('reads only the selected fixed environment when a native model is required', async () => {
    const nativeModel = {
      runtime: 'codex' as const,
      source: 'native' as const,
      provider: 'native-provider',
      model_id: 'native-model',
    }
    const readNative = vi.fn().mockResolvedValue({
      models: [
        {
          ...nativeModel,
          label: 'Native',
          local_model_id: 'native-model',
          account_label: 'Local',
          is_default: true,
        },
      ],
    })
    const listCloud = vi.fn().mockRejectedValue(new Error('Cloud is offline'))
    const fixed = {
      ...agent,
      executionPolicy: { mode: 'fixed' as const, environment_id: 'device' },
      modelPolicy: { mode: 'fixed' as const, model: nativeModel },
    }
    const inventory = [
      { ...environments[0], models: [] },
      { ...environments[0], id: 'unrelated', models: [] },
    ]
    await validateAutomationRunnerSelections(
      [fixed],
      [],
      inventory,
      listCloud,
      [rule()],
      readNative
    )
    expect(readNative).toHaveBeenCalledTimes(1)
    expect(readNative).toHaveBeenCalledWith(expect.objectContaining({ id: 'device' }))
    expect(listCloud).not.toHaveBeenCalled()
  })

  it('uses a previously selected cloud model without reading the fixed devices native catalog', async () => {
    const readNative = vi.fn().mockRejectedValue(new Error('Native catalog is unavailable'))
    const fixed: AutomationRoutingTarget = {
      ...agent,
      executionPolicy: { mode: 'fixed', environment_id: 'device' },
    }
    await validateAutomationRunnerSelections(
      [fixed],
      [],
      environments,
      async () => cloudModels,
      [{ ...rule(), runnerSelection: { model } }],
      readNative
    )
    expect(readNative).not.toHaveBeenCalled()
  })

  it('does not let unrelated native catalogs block a cloud-model automation', async () => {
    const readNative = vi.fn().mockRejectedValue(new Error('Unrelated device is disconnected'))
    const fixed = {
      ...agent,
      executionPolicy: { mode: 'fixed' as const, environment_id: 'device' },
      modelPolicy: { mode: 'fixed' as const, model },
    }
    await validateAutomationRunnerSelections(
      [fixed],
      [],
      environments,
      async () => cloudModels,
      [rule()],
      readNative
    )
    expect(readNative).not.toHaveBeenCalled()
  })

  it('does not open a picker for fixed policies and rejects unavailable targets', async () => {
    const choose = vi.fn()
    const unregister = registerRunnerSelectionHandler(choose)
    try {
      const fixed: AutomationRoutingTarget = {
        ...agent,
        executionPolicy: { mode: 'project_pool' },
        modelPolicy: { mode: 'fixed', model },
      }
      await validateAutomationRunnerSelections([fixed], [], environments, async () => cloudModels, [
        rule(),
      ])
      expect(choose).not.toHaveBeenCalled()
      await expect(
        validateAutomationRunnerSelections([], [], environments, async () => cloudModels, [rule()])
      ).rejects.toThrow('unavailable')
    } finally {
      unregister()
    }
  })
})
