// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import {
  resolveLocalRuntimeModelConfig,
  CLOUD_MODEL_NAMESPACE_OPTION,
  CLOUD_MODEL_RESOURCE_USER_ID_OPTION,
  CLOUD_MODEL_CONTEXT_WINDOW_OPTION,
} from '@wegent/chat-core/local-runtime-model'
import type { UnifiedModel } from '@wegent/chat-core/models'
import { ModelSelector } from '../controls/ModelSelector'
import { createCollaborationTranslator } from '../i18n'
import { generationModelKey, useProjectGenerationModels } from './useProjectGenerationModels'
import type { ProjectCreateGenerationModel, ProjectCreateGenerationModelCatalog } from './types'

it.each(['deepseek-v4-flash', 'gpt-6.1-sol'])(
  'preserves authoritative cloud routing after choosing %s through the real model picker',
  async name => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const models: ProjectCreateGenerationModel[] = [
      {
        modelName: 'deepseek-v4-flash',
        modelType: 'public',
        displayName: 'DeepSeek',
        options: {
          [CLOUD_MODEL_NAMESPACE_OPTION]: 'default',
          [CLOUD_MODEL_RESOURCE_USER_ID_OPTION]: '0',
          [CLOUD_MODEL_CONTEXT_WINDOW_OPTION]: '128000',
        },
      },
      {
        modelName: 'gpt-6.1-sol',
        modelType: 'group',
        displayName: 'GPT',
        options: {
          [CLOUD_MODEL_NAMESPACE_OPTION]: 'engineering',
          [CLOUD_MODEL_RESOURCE_USER_ID_OPTION]: '42',
          [CLOUD_MODEL_CONTEXT_WINDOW_OPTION]: '256000',
        },
      },
    ]
    const catalog: ProjectCreateGenerationModelCatalog = { models, defaultSelection: models[0] }
    const loader = vi.fn(async () => catalog)
    let state!: ReturnType<typeof useProjectGenerationModels>
    function Harness() {
      state = useProjectGenerationModels(true, loader, undefined, 'Failed')
      const pickerModels: UnifiedModel[] = state.models.map(model => ({
        name: model.modelName,
        type: model.modelType ?? 'runtime',
        displayName: model.displayName,
      }))
      return (
        <ModelSelector
          translate={createCollaborationTranslator('en')}
          isMobile={false}
          onOpenModelSettings={vi.fn()}
          models={pickerModels}
          selectedModel={
            pickerModels.find(
              model =>
                generationModelKey({ modelName: model.name, modelType: model.type }) === state.key
            ) ?? null
          }
          selectedModelOptions={state.options}
          disabled={state.loading}
          onSelectModel={model =>
            model ? state.selectModel({ modelName: model.name, modelType: model.type }) : false
          }
          onSelectModelAndOptions={(model, options) =>
            state.selectModel({ modelName: model.name, modelType: model.type }, options)
          }
          onSelectModelOption={(key, value) =>
            state.setOptions(current => ({ ...current, [key]: value }))
          }
        />
      )
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const click = async (id: string) => {
      const button = document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!
      expect(button).not.toBeNull()
      await act(async () => button.click())
    }
    try {
      await act(async () => root.render(<Harness />))
      await click('model-selector-button')
      await click('model-advanced-toggle')
      await click(`model-option-${name}`)
      const selected = models.find(model => model.modelName === name)!
      expect(state.key).toBe(generationModelKey(selected))
      expect(state.options).toMatchObject(selected.options!)
      const configuration = resolveLocalRuntimeModelConfig({
        runtime: 'codex',
        modelName: selected.modelName,
        modelType: selected.modelType,
        modelOptions: state.options,
        cloudModelGateway: { baseUrl: 'https://example.test/runtime-proxy', apiKey: 'unit-test' },
      })
      expect(configuration.default_headers).toMatchObject({
        'X-Wegent-Model-Namespace': selected.options![CLOUD_MODEL_NAMESPACE_OPTION],
        'X-Wegent-Model-User-Id': selected.options![CLOUD_MODEL_RESOURCE_USER_ID_OPTION],
      })
      expect(configuration.model_context_window).toBe(
        Number(selected.options![CLOUD_MODEL_CONTEXT_WINDOW_OPTION])
      )
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  }
)
