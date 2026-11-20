import { useRef } from 'react'
import { DialogSurface } from './DialogSurface'
// @vitest-environment jsdom

import type { CodexOfficialModel } from '@wegent/chat-core/codex-official-models'
import type { ModelOptions, UnifiedModel } from '@wegent/chat-core/models'
import { codexRuntimeModels } from '@wegent/chat-core/runtime-model-catalog'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import { CollaborationTheme } from '../theme'
import { ModelSelector } from './ModelSelector'
import { PermissionModeSelector } from './PermissionModeSelector'

let container: HTMLDivElement
let root: Root
const translate = createCollaborationTranslator('zh-CN')

const cloudDeepseekModel: UnifiedModel = {
  name: 'deepseek-flash-responses(公网)',
  type: 'public',
  displayName: '公网:DeepSeek-V4-Flash',
  modelId: 'deepseek-flash',
  config: { protocol: 'openai-responses' },
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function element(id: string) {
  const target = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (!target) throw new Error(`Missing control ${id}`)
  return target
}

function officialModel(modelId: string, isDefault = false): CodexOfficialModel {
  return {
    id: modelId,
    displayName: modelId,
    modelId,
    providerId: 'openai',
    providerName: 'OpenAI',
    providerType: 'official',
    providerCurrent: true,
    description: null,
    hidden: false,
    isDefault,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    supportsFastMode: true,
  }
}

describe('model controls without a desktop host', () => {
  it('keeps an open model list when reasoning arrives with the catalog', () => {
    const models = codexRuntimeModels([officialModel('gpt-6.1-sol', true)], null, true)
    const render = (ready: boolean) =>
      act(() =>
        root.render(
          <ModelSelector
            translate={translate}
            isMobile={false}
            models={ready ? models : []}
            selectedModel={ready ? models[0] : null}
            selectedModelOptions={{ reasoning: 'medium' }}
            disabled={false}
            onSelectModel={vi.fn()}
            onSelectModelOption={vi.fn()}
            onOpenModelSettings={vi.fn()}
          />
        )
      )
    render(false)
    act(() => element('model-selector-button').click())
    expect(element('model-selector-menu').getAttribute('data-panel')).toBe('advanced')
    render(true)
    expect(element('model-selector-menu').getAttribute('data-panel')).toBe('advanced')
    expect(element('model-option-default').getAttribute('aria-checked')).toBe('true')
    act(() => element('model-option-gpt-6.1-sol').click())
    expect(element('model-selector-menu').getAttribute('data-panel')).toBe('simple')
    act(() => element('model-selector-button').click())
    act(() => element('model-selector-button').click())
    expect(element('model-selector-menu').getAttribute('data-panel')).toBe('simple')
  })

  it('owns radio choices separate from reasoning controls within its modal picker', async () => {
    const models = codexRuntimeModels(
      [officialModel('gpt-6.1-sol', true), officialModel('gpt-6-astra')],
      null,
      true
    )
    act(() =>
      root.render(
        <ModelSelector
          translate={translate}
          isMobile={false}
          models={models}
          selectedModel={models[0]}
          selectedModelOptions={{ reasoning: 'medium' }}
          disabled={false}
          onSelectModel={vi.fn()}
          onSelectModelOption={vi.fn()}
          onOpenModelSettings={vi.fn()}
        />
      )
    )
    act(() => {
      element('model-selector-button').focus()
      element('model-selector-button').click()
    })
    act(() => element('model-advanced-toggle').click())
    const selected = element('model-option-default')
    const menu = selected.closest<HTMLElement>('[role="radiogroup"]')
    expect(menu?.getAttribute('aria-label')).toBe('选择模型')
    expect(menu?.querySelector('[role="slider"]')).toBeNull()
    await vi.waitFor(() => expect(document.activeElement).toBe(selected))
    const options = [...menu!.querySelectorAll<HTMLElement>('[role="radio"]')]
    const press = (key: string, shiftKey = false) => {
      const event = new KeyboardEvent('keydown', {
        key,
        shiftKey,
        bubbles: true,
        cancelable: true,
      })
      act(() => {
        document.activeElement?.dispatchEvent(event)
      })
      return event
    }
    act(() => options.at(-1)!.focus())
    expect(options.filter(option => option.tabIndex === 0)).toEqual([selected])
    press('Escape')
    expect(document.querySelector('[data-testid="model-selector-menu"]')).toBeNull()
    await vi.waitFor(() => expect(document.activeElement).toBe(element('model-selector-button')))
  })

  it.each(['model', 'preset'])(
    'keeps selection intent when the host rejects an atomic %s selection',
    kind => {
      const models = codexRuntimeModels([officialModel('gpt-6.1-sol', true)], null, true)
      const selected = models[0]
      const atomic = vi.fn(() => false)
      const selectModel = vi.fn()
      const selectOption = vi.fn()
      act(() =>
        root.render(
          <ModelSelector
            translate={translate}
            isMobile={false}
            models={models}
            selectedModel={selected}
            selectedModelOptions={{ reasoning: 'medium' }}
            disabled={false}
            onSelectModel={selectModel}
            onSelectModelAndOptions={atomic}
            onSelectModelOption={selectOption}
            onOpenModelSettings={vi.fn()}
          />
        )
      )
      act(() => element('model-selector-button').click())
      act(() => element('model-advanced-toggle').click())
      act(() =>
        element(kind === 'model' ? `model-option-${selected.name}` : 'model-option-default').click()
      )
      expect(atomic).toHaveBeenCalledOnce()
      expect(selectModel).not.toHaveBeenCalled()
      expect(selectOption).not.toHaveBeenCalled()
      act(() => element('model-selector-button').click())
      expect(element('model-selection-mode').textContent).toBe('推荐模型集')
    }
  )

  it('does not label an empty selection as a fixed model', () => {
    const models = codexRuntimeModels([officialModel('gpt-6.1-sol', true)], null, true)
    act(() =>
      root.render(
        <ModelSelector
          translate={translate}
          isMobile={false}
          models={models}
          selectedModel={null}
          selectedModelOptions={{}}
          disabled={false}
          onSelectModel={vi.fn()}
          onSelectModelOption={vi.fn()}
          onOpenModelSettings={vi.fn()}
        />
      )
    )
    act(() => element('model-selector-button').click())
    expect(element('model-selector-menu')).toBeTruthy()
    expect(document.querySelector('[data-testid="model-selection-mode"]')).toBeNull()
    expect(document.querySelector('[data-testid="model-slider-description"]')).toBeNull()
  })

  it.each(['zh-CN', 'en'] as const)(
    'distinguishes model sets from fixed models through selection and reset (%s)',
    locale => {
      const t = createCollaborationTranslator(locale)
      const models = codexRuntimeModels(
        [
          officialModel('gpt-6-luna'),
          officialModel('gpt-6.1-sol', true),
          officialModel('gpt-6-astra'),
        ],
        null,
        true
      )
      const initialModel = models.find(model => model.modelId === 'gpt-6.1-sol')!
      function Harness() {
        const [model, setModel] = useState<UnifiedModel | null>(initialModel)
        const [options, setOptions] = useState<ModelOptions>({
          reasoning: 'medium',
        })
        const [generation, setGeneration] = useState(0)
        return (
          <>
            <button
              data-testid="remount-model-selector"
              onClick={() => setGeneration(current => current + 1)}
            >
              Remount
            </button>
            <ModelSelector
              key={generation}
              translate={t}
              isMobile={false}
              models={models}
              selectedModel={model}
              selectedModelOptions={options}
              disabled={false}
              onSelectModel={setModel}
              onSelectModelAndOptions={(nextModel, nextOptions) => {
                setModel(nextModel)
                setOptions(nextOptions)
              }}
              onSelectModelOption={(key, value) =>
                setOptions(current => ({ ...current, [key]: value }))
              }
              onOpenModelSettings={vi.fn()}
            />
          </>
        )
      }
      act(() => root.render(<Harness />))
      act(() => element('model-selector-button').click())
      expect(element('model-selection-mode').textContent).toBe(t('workbench.model_recommended_set'))
      expect(element('model-slider-description').textContent).toBe(
        t('workbench.model_set_slider_hint')
      )

      act(() => element('model-power-setting-gpt-6-astra-low').click())
      expect(element('model-simple-name').textContent).toContain('astra')
      expect(element('model-selection-mode').textContent).toBe(t('workbench.model_recommended_set'))

      // Explicitly choosing the same model still changes the slider's meaning.
      act(() => element('model-advanced-toggle').click())
      const astra = models.find(model => model.modelId === 'gpt-6-astra')!
      act(() => element(`model-option-${astra.name}`).click())
      expect(element('model-selection-mode').textContent).toBe(t('workbench.model_fixed'))
      expect(element('model-slider-description').textContent).toBe(
        t('workbench.fixed_model_slider_hint')
      )
      act(() => element('remount-model-selector').click())
      act(() => element('model-selector-button').click())
      expect(element('model-selection-mode').textContent).toBe(t('workbench.model_fixed'))
      expect(
        document.querySelector('[data-testid="model-power-setting-gpt-6-1-sol-medium"]')
      ).toBeNull()

      act(() => element('model-reset-default-button').click())
      expect(element('model-selection-mode').textContent).toBe(t('workbench.model_recommended_set'))
      expect(element('model-simple-name').textContent).toBe(initialModel.displayName)
      act(() => element('remount-model-selector').click())
      act(() => element('model-selector-button').click())
      expect(element('model-selection-mode').textContent).toBe(t('workbench.model_recommended_set'))
    }
  )

  it.each([false, true])(
    'separates same-name resource selections from display metadata (mobile=%s)',
    isMobile => {
      const models: UnifiedModel[] = [1, 2].map(resourceUserId => ({
        name: 'shared-kimi',
        displayName: '内网:Kimi-K3',
        type: 'user',
        namespace: 'default',
        resourceUserId,
        modelId: 'kimi-k3',
        config: { protocol: 'openai-responses' },
      }))
      const onSelectModel = vi.fn()
      act(() =>
        root.render(
          <ModelSelector
            translate={translate}
            isMobile={isMobile}
            models={models}
            getModelOptionId={model => `owner-${model.resourceUserId}`}
            selectedModel={models[1]}
            selectedModelOptions={{}}
            disabled={false}
            onSelectModel={onSelectModel}
            onSelectModelOption={() => {}}
            onOpenModelSettings={() => {}}
          />
        )
      )
      act(() => element('model-selector-button').click())
      const first = element('model-option-owner-1')
      const second = element('model-option-owner-2')
      expect(first.textContent).toContain('内网:Kimi-K3')
      expect(second.textContent).toContain('内网:Kimi-K3')
      if (isMobile) {
        expect(first.querySelector('.lucide-check')).toBeNull()
        expect(second.querySelector('.lucide-check')).not.toBeNull()
      } else {
        expect(first.getAttribute('aria-checked')).toBe('false')
        expect(second.getAttribute('aria-checked')).toBe('true')
      }
      act(() => first.click())
      expect(onSelectModel).toHaveBeenLastCalledWith(models[0])
      expect(models.map(model => model.name)).toEqual(['shared-kimi', 'shared-kimi'])
    }
  )

  it.each([false, true])(
    'selects the preset owner without an explicit effort even when it is second (atomic=%s)',
    atomic => {
      const firstModel: UnifiedModel = {
        name: 'cloud-first-deepseek',
        type: 'public',
        config: { ui: { family: 'deepseek' } },
      }
      const defaultModel: UnifiedModel = {
        ...cloudDeepseekModel,
        config: {
          ...cloudDeepseekModel.config,
          ui: {
            defaultModel: true,
            sliderModelsConfig: {
              defaultPreset: 'recommended',
              presets: [
                {
                  name: 'recommended',
                  models: [{ modelName: firstModel.name }, { modelName: cloudDeepseekModel.name }],
                },
              ],
            },
          },
        },
      }
      const onSelectModel = vi.fn()
      const onSelectModelOption = vi.fn()
      const onSelectModelAndOptions = vi.fn()
      act(() =>
        root.render(
          <ModelSelector
            translate={translate}
            isMobile={false}
            models={[firstModel, defaultModel]}
            selectedModel={firstModel}
            selectedModelOptions={{ reasoning: 'high' }}
            disabled={false}
            onSelectModel={onSelectModel}
            onSelectModelOption={onSelectModelOption}
            onSelectModelAndOptions={atomic ? onSelectModelAndOptions : undefined}
            onOpenModelSettings={vi.fn()}
          />
        )
      )
      act(() => element('model-selector-button').click())
      act(() => element('model-advanced-toggle').click())
      act(() => element('model-option-default').click())
      if (atomic) {
        expect(onSelectModelAndOptions).toHaveBeenCalledWith(defaultModel, {
          modelSelection: 'public:deepseek-flash-responses(公网):recommended',
        })
        expect(onSelectModelOption).not.toHaveBeenCalled()
      } else {
        expect(onSelectModel).toHaveBeenCalledWith(defaultModel)
        expect(onSelectModelOption).toHaveBeenCalledExactlyOnceWith(
          'modelSelection',
          'public:deepseek-flash-responses(公网):recommended'
        )
      }
    }
  )

  it.each([false, true])(
    'selects model-only preset steps without reasoning (atomic=%s)',
    atomic => {
      const glm: UnifiedModel = {
        name: 'cloud-glm',
        type: 'public',
        config: {
          ui: {
            family: 'glm',
            defaultModel: true,
            sliderModelsConfig: {
              defaultPreset: 'recommended',
              presets: [
                {
                  name: 'recommended',
                  models: [{ modelName: 'cloud-glm' }, { modelName: 'cloud-deepseek' }],
                },
              ],
            },
          },
        },
      }
      const deepseek: UnifiedModel = {
        name: 'cloud-deepseek',
        type: 'public',
        config: { ui: { family: 'deepseek' } },
      }
      const onSelectModel = vi.fn()
      const onSelectModelOption = vi.fn()
      const onSelectModelAndOptions = vi.fn()
      act(() =>
        root.render(
          <ModelSelector
            translate={translate}
            isMobile={false}
            models={[glm, deepseek]}
            selectedModel={glm}
            selectedModelOptions={{}}
            disabled={false}
            onSelectModel={onSelectModel}
            onSelectModelOption={onSelectModelOption}
            onSelectModelAndOptions={atomic ? onSelectModelAndOptions : undefined}
            onOpenModelSettings={vi.fn()}
          />
        )
      )
      act(() => element('model-selector-button').click())
      expect(element('model-power-setting-cloud-glm').getAttribute('aria-label')).not.toContain(
        'undefined'
      )
      expect(element('model-power-setting-cloud-deepseek')).toBeTruthy()
      act(() => element('model-power-setting-cloud-deepseek').click())
      if (atomic) {
        expect(onSelectModelAndOptions).toHaveBeenCalledWith(deepseek, {})
      } else {
        expect(onSelectModel).toHaveBeenCalledWith(deepseek)
      }
      expect(onSelectModelOption).not.toHaveBeenCalled()

      act(() => element('model-advanced-toggle').click())
      expect(element('model-option-default').parentElement).toBe(element('model-source-cloud'))
      act(() => element('model-option-default').click())
      if (atomic) {
        expect(onSelectModelAndOptions).toHaveBeenLastCalledWith(glm, {
          modelSelection: 'public:cloud-glm:recommended',
        })
        expect(onSelectModelOption).not.toHaveBeenCalled()
      } else {
        expect(onSelectModel).toHaveBeenLastCalledWith(glm)
        expect(onSelectModelOption).toHaveBeenCalledExactlyOnceWith(
          'modelSelection',
          'public:cloud-glm:recommended'
        )
      }
    }
  )

  it('renders cloud presets before family groups and keeps local presets in their source', () => {
    const cloudModel: UnifiedModel = {
      ...cloudDeepseekModel,
      config: {
        ui: {
          defaultModel: true,
          reasoningEfforts: ['medium'],
          sliderModelsConfig: {
            defaultPreset: 'recommended',
            presets: [
              {
                name: 'recommended',
                label: '推荐',
                models: [
                  {
                    modelName: cloudDeepseekModel.name,
                    reasoningEffort: 'medium',
                  },
                ],
              },
              {
                name: 'quality',
                label: '高质量',
                models: [{ modelName: 'cloud-gpt', reasoningEffort: 'high' }],
              },
            ],
          },
        },
      },
    }
    const gptModel: UnifiedModel = {
      name: 'cloud-gpt',
      type: 'public',
      config: { ui: { family: 'gpt', reasoningEfforts: ['high'] } },
    }
    const localModels = codexRuntimeModels([officialModel('gpt-6.1-sol', true)], null, true)
    const onSelectModelAndOptions = vi.fn()

    act(() =>
      root.render(
        <ModelSelector
          translate={translate}
          isMobile={false}
          models={[cloudModel, gptModel, ...localModels]}
          selectedModel={cloudModel}
          selectedModelOptions={{ reasoning: 'medium' }}
          disabled={false}
          onSelectModel={vi.fn()}
          onSelectModelOption={vi.fn()}
          onSelectModelAndOptions={onSelectModelAndOptions}
          onOpenModelSettings={vi.fn()}
        />
      )
    )
    act(() => element('model-selector-button').click())

    const cloudSource = element('model-source-cloud')
    const cloudPresets = cloudSource.querySelectorAll('[data-model-preset]')
    expect(cloudPresets).toHaveLength(2)
    for (const preset of cloudPresets) {
      expect(preset.parentElement).toBe(cloudSource)
      expect(
        preset.compareDocumentPosition(element(`model-option-${cloudModel.name}`)) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
    }
    expect(element(`model-option-${cloudModel.name}`).parentElement).toBe(
      element('model-group-deepseek')
    )
    expect(element('model-option-cloud-gpt').parentElement).toBe(element('model-group-gpt'))
    const localSource = element('model-source-local-chatgpt')
    const localPresets = localSource.querySelectorAll('[data-model-preset]')
    expect(localPresets).toHaveLength(1)
    expect(localPresets[0].parentElement).toBe(localSource)

    act(() => element('model-option-preset-quality').click())
    expect(onSelectModelAndOptions).toHaveBeenCalledWith(gptModel, {
      modelSelection: 'public:deepseek-flash-responses(公网):quality',
      reasoning: 'high',
    })
  })

  it.each([false, true])('keeps the scoped theme in the model portal (mobile=%s)', mobile => {
    const openSettings = vi.fn()
    act(() =>
      root.render(
        <CollaborationTheme mode="dark">
          <ModelSelector
            translate={translate}
            isMobile={mobile}
            models={[]}
            selectedModel={null}
            selectedModelOptions={{}}
            disabled={false}
            onSelectModel={vi.fn()}
            onSelectModelOption={vi.fn()}
            onOpenModelSettings={openSettings}
            onOpenCloudConnections={vi.fn()}
          />
        </CollaborationTheme>
      )
    )
    act(() => element('model-selector-button').click())
    const menu = element('model-selector-menu')
    const surface = menu.closest<HTMLElement>('.collaboration-theme')!
    expect(surface).not.toBeNull()
    expect(container.contains(surface)).toBe(false)
    expect(surface.dataset.theme).toBe('dark')
    expect(surface.style.getPropertyValue('--color-bg-base')).toBe('24 24 24')
    expect(surface.style.display).not.toBe('contents')
    expect(menu.textContent).not.toContain('workbench.')
    act(() => element('model-selector-add-custom-model').click())
    expect(openSettings).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-testid="model-selector-menu"]')).toBeNull()
  })

  it('preserves the theme and deliberate permission confirmation across both portals', () => {
    const onChange = vi.fn()
    act(() =>
      root.render(
        <CollaborationTheme mode="dark">
          <PermissionModeSelector translate={translate} value="read-only" onChange={onChange} />
        </CollaborationTheme>
      )
    )
    act(() => element('permission-mode-menu-button').click())
    expect(
      element('permission-mode-menu-button-menu').style.getPropertyValue('--color-bg-base')
    ).toBe('24 24 24')
    act(() => element('permission-mode-full-access').click())
    expect(onChange).not.toHaveBeenCalled()
    expect(element('full-access-confirm-overlay').dataset.theme).toBe('dark')
    act(() => element('full-access-confirm-submit').click())
    expect(onChange).toHaveBeenCalledWith('full-access')
  })

  it('does not apply preset options when the host rejects the model selection', () => {
    const models = codexRuntimeModels(
      [
        officialModel('gpt-6-luna'),
        officialModel('gpt-6.1-sol', true),
        officialModel('gpt-6-astra'),
      ],
      null,
      true
    )
    const selectedModel = models.find(model => model.modelId === 'gpt-6.1-sol')!
    const onSelectModel = vi.fn(() => false)
    const onSelectModelOption = vi.fn()

    act(() =>
      root.render(
        <CollaborationTheme mode="dark">
          <ModelSelector
            translate={translate}
            isMobile={false}
            models={models}
            selectedModel={selectedModel}
            selectedModelOptions={{ reasoning: 'high', speed: 'fast' }}
            disabled={false}
            onSelectModel={onSelectModel}
            onSelectModelOption={onSelectModelOption}
            onOpenModelSettings={vi.fn()}
          />
        </CollaborationTheme>
      )
    )

    act(() => element('model-selector-button').click())
    expect(element('model-advanced-fast-mode-toggle').getAttribute('aria-label')).toBe(
      translate('workbench.speed_fast', '快速')
    )
    act(() => element('model-reset-default-button').click())

    expect(onSelectModel).toHaveBeenCalledOnce()
    expect(onSelectModelOption).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="model-selector-menu"]')).toBeNull()
  })

  it('keeps default mode when the host rejects a direct model selection', () => {
    const models = codexRuntimeModels(
      [
        officialModel('gpt-6-luna'),
        officialModel('gpt-6.1-sol', true),
        officialModel('gpt-6-astra'),
      ],
      null,
      true
    )
    const selectedModel = models.find(model => model.modelId === 'gpt-6.1-sol')!
    const alternateModel = models.find(model => model.modelId === 'gpt-6-astra')!
    const onSelectModel = vi.fn(() => false)

    act(() =>
      root.render(
        <CollaborationTheme mode="dark">
          <ModelSelector
            translate={translate}
            isMobile={false}
            models={models}
            selectedModel={selectedModel}
            selectedModelOptions={{ reasoning: 'medium', speed: 'standard' }}
            disabled={false}
            onSelectModel={onSelectModel}
            onSelectModelOption={vi.fn()}
            onOpenModelSettings={vi.fn()}
          />
        </CollaborationTheme>
      )
    )

    act(() => element('model-selector-button').click())
    expect(document.querySelector('[data-testid="model-reset-default-button"]')).toBeNull()
    act(() => element('model-advanced-toggle').click())
    act(() => element(`model-option-${alternateModel.name}`).click())

    expect(onSelectModel).toHaveBeenCalledWith(alternateModel)
    expect(document.querySelector('[data-testid="model-selector-menu"]')).toBeNull()

    act(() => element('model-selector-button').click())
    expect(document.querySelector('[data-testid="model-reset-default-button"]')).toBeNull()
  })

  it.each(['deepseek', 'gpt', 'model-interface'])(
    'exposes catalog reasoning levels for a cloud model in the %s family',
    family => {
      const model = {
        ...cloudDeepseekModel,
        config: { ...cloudDeepseekModel.config, ui: { family } },
      }
      const onSelectModelOption = vi.fn()
      act(() =>
        root.render(
          <CollaborationTheme mode="dark">
            <ModelSelector
              translate={translate}
              isMobile
              models={[model]}
              selectedModel={model}
              selectedModelOptions={{ reasoning: 'high' }}
              disabled={false}
              onSelectModel={vi.fn()}
              onSelectModelOption={onSelectModelOption}
              onOpenModelSettings={vi.fn()}
              onOpenCloudConnections={vi.fn()}
            />
          </CollaborationTheme>
        )
      )

      act(() => element('model-selector-button').click())
      // element() throws when a control is missing.
      const optionLabels = ['low', 'high', 'max'].map(value =>
        element(`model-control-reasoning-${value}`).textContent?.trim()
      )
      expect(optionLabels.every(Boolean)).toBe(true)
      expect(document.querySelector('[data-testid="model-control-reasoning-medium"]')).toBeNull()
      expect(document.querySelector('[data-testid="model-control-reasoning-xhigh"]')).toBeNull()
      act(() => element('model-control-reasoning-max').click())

      expect(onSelectModelOption).toHaveBeenCalledWith('reasoning', 'max')
    }
  )

  it.each(['deepseek', 'gpt', 'model-interface'])(
    'enables the reasoning slider for a cloud catalog model in the %s family on desktop',
    family => {
      const model = {
        ...cloudDeepseekModel,
        config: { ...cloudDeepseekModel.config, ui: { family } },
      }
      const onSelectModelOption = vi.fn()
      act(() =>
        root.render(
          <CollaborationTheme mode="dark">
            <ModelSelector
              translate={translate}
              isMobile={false}
              models={[model]}
              selectedModel={model}
              selectedModelOptions={{ reasoning: 'high' }}
              disabled={false}
              onSelectModel={vi.fn()}
              onSelectModelOption={onSelectModelOption}
              onOpenModelSettings={vi.fn()}
              onOpenCloudConnections={vi.fn()}
            />
          </CollaborationTheme>
        )
      )

      act(() => element('model-selector-button').click())

      const reasoningSlider = element('model-control-reasoning-track')
      expect(reasoningSlider.getAttribute('aria-label')).toBe(
        translate('workbench.reasoning_level', 'Reasoning')
      )
      expect(reasoningSlider.getAttribute('aria-valuetext')).toBe(
        translate('workbench.local_model_reasoning_high', 'High')
      )
      act(() => element('model-control-reasoning-max').click())
      expect(onSelectModelOption).toHaveBeenCalledWith('reasoning', 'max')
    }
  )
})

it.each([false, true])(
  'uses the provided recovery action for an empty catalog (mobile=%s)',
  isMobile => {
    const reload = vi.fn()
    act(() =>
      root.render(
        <ModelSelector
          translate={translate}
          isMobile={isMobile}
          models={[]}
          selectedModel={null}
          selectedModelOptions={{}}
          disabled={false}
          onSelectModel={vi.fn()}
          onSelectModelOption={vi.fn()}
          emptyState={
            <button data-testid="reload-fixture-models" onClick={reload}>
              Reload models
            </button>
          }
        />
      )
    )
    act(() => element('model-selector-button').click())
    expect(document.querySelector('[data-testid="model-selector-add-custom-model"]')).toBeNull()
    act(() => element('reload-fixture-models').click())
    expect(reload).toHaveBeenCalledOnce()
  }
)

it.each(['editor', 'trigger'] as const)(
  'owns portaled keyboard focus and restores its %s opener',
  async opener => {
    const onClose = vi.fn()
    const otherModel = {
      ...cloudDeepseekModel,
      name: 'other-cloud',
      displayName: 'Other cloud model',
    }
    function Host() {
      const ref = useRef<HTMLDivElement>(null)
      const [selected, setSelected] = useState(cloudDeepseekModel)
      return (
        <DialogSurface
          onClose={onClose}
          render={<div ref={ref} aria-label="Parent" tabIndex={-1} />}
        >
          <input data-testid="host-editor" />
          <ModelSelector
            translate={translate}
            isMobile={false}
            models={[cloudDeepseekModel, otherModel]}
            selectedModel={selected}
            selectedModelOptions={{}}
            onSelectModel={setSelected}
            onSelectModelOption={vi.fn()}
            onOpenModelSettings={vi.fn()}
          />
          <button data-testid="host-last">Last parent control</button>
        </DialogSurface>
      )
    }
    await act(async () => root.render(<Host />))
    await vi.waitFor(() => expect(document.activeElement).toBe(element('host-editor')))
    const previous = element(opener === 'editor' ? 'host-editor' : 'model-selector-button')
    act(() => previous.focus())
    act(() => element('model-selector-button').click())
    const picker = element('model-selector-menu').closest<HTMLElement>('[role="dialog"]')!
    expect(picker.getAttribute('aria-modal')).toBe('true')
    expect(element('model-selector-button').getAttribute('aria-controls')).toBe(picker.id)
    expect(picker.getAttribute('aria-label')).toBe('选择模型')
    expect(element('model-selector-button').getAttribute('aria-haspopup')).toBe('dialog')
    await vi.waitFor(() => expect(picker.contains(document.activeElement)).toBe(true))
    expect(element('model-selector-menu').dataset.panel).toBe('simple')
    act(() => element('model-advanced-toggle').click())
    expect(element('model-selector-menu').dataset.panel).toBe('advanced')
    const radios = [...picker.querySelectorAll<HTMLElement>('[role="radio"]')]
    expect(radios).toHaveLength(2)
    expect(radios.every(radio => radio.closest('[role="radiogroup"]'))).toBe(true)
    expect(picker.querySelector('[role="menuitemradio"]')).toBeNull()
    expect(radios.filter(radio => radio.tabIndex === 0)).toHaveLength(1)
    const press = (target: HTMLElement, key: string, shiftKey = false) =>
      act(() => {
        target.dispatchEvent(
          new KeyboardEvent('keydown', {
            key,
            keyCode: key === 'Escape' ? 27 : 0,
            bubbles: true,
            cancelable: true,
            shiftKey,
          })
        )
      })
    act(() => radios[0].focus())
    act(() =>
      radios[0].dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          keyCode: 229,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        })
      )
    )
    expect(radios[0].getAttribute('aria-checked')).toBe('true')
    press(radios[0], 'ArrowDown')
    expect(radios[1].getAttribute('aria-checked')).toBe('true')
    expect(picker.contains(document.activeElement)).toBe(true)
    await vi.waitFor(() =>
      expect(document.activeElement?.closest('[inert], [aria-hidden="true"]')).toBeNull()
    )
    const controls = [
      ...picker.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]):not([type="hidden"])'),
    ].filter(control => control.tabIndex >= 0 && !control.closest('[inert], [aria-hidden="true"]'))
    expect(controls.length).toBeGreaterThan(0)
    const first = controls[0]
    const last = controls.at(-1)!
    act(() => last.focus())
    press(last, 'Tab')
    expect(document.activeElement).toBe(first)
    press(first, 'Tab', true)
    expect(document.activeElement).toBe(last)
    press(last, 'Escape')
    expect(document.querySelector('[data-testid="model-selector-menu"]')).toBeNull()
    await vi.waitFor(() => expect(document.activeElement).toBe(previous))
    expect(onClose).not.toHaveBeenCalled()
    press(previous, 'Escape')
    expect(onClose).toHaveBeenCalledOnce()
  }
)
