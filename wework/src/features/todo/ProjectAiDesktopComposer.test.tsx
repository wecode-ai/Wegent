// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAppPreferences } from '@/desktop/appPreferences'
import { AppPreferencesContext } from '@/features/app-preferences/appPreferencesContext'
import type { UnifiedModel } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { ProjectAiDesktopComposer } from './ProjectAiDesktopComposer'

const updateAppPreferences = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('@/desktop/appPreferences', async importOriginal => ({
  ...(await importOriginal<typeof import('@/desktop/appPreferences')>()),
  updateAppPreferences,
}))

vi.mock('@/components/chat/composer/ProjectChatComposer', async () => {
  const { forwardRef } = await import('react')
  return {
    ProjectChatComposer: forwardRef(function ProjectChatComposer(props: {
      selectedModel: UnifiedModel | null
      models: UnifiedModel[]
      onSelectModel(model: UnifiedModel): boolean
      onSelectModelOption(key: string, value: string): void
      onSubmit(value: string): void
    }) {
      return (
        <div>
          <span data-testid="selected-model">{props.selectedModel?.name ?? ''}</span>
          <button
            type="button"
            data-testid="select-first-model"
            onClick={() => props.onSelectModel(props.models[0]!)}
          >
            Select first
          </button>
          <button
            type="button"
            data-testid="select-reasoning"
            onClick={() => props.onSelectModelOption('reasoning', 'high')}
          >
            Select reasoning
          </button>
          <button
            type="button"
            data-testid="submit"
            onClick={() => props.onSubmit('Manage this project')}
          >
            Submit
          </button>
        </div>
      )
    }),
  }
})

const models = [
  {
    name: 'model-one',
    type: 'public',
    displayName: 'Model One',
    isActive: true,
  },
  {
    name: 'model-two',
    type: 'runtime',
    displayName: 'Model Two',
    isActive: true,
    config: {
      codexProviderId: 'openai',
      codexProviderName: 'OpenAI',
      codexProviderType: 'official',
    },
  },
] as UnifiedModel[]

describe('ProjectAiDesktopComposer', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    updateAppPreferences.mockClear()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('restores and persists the last project AI model across projects', async () => {
    const onSubmit = vi.fn()
    await act(async () => {
      root.render(
        <AppPreferencesContext.Provider
          value={{
            loaded: true,
            preferences: {
              ...defaultAppPreferences,
              projectAiModelSelection: {
                modelName: 'model-two',
                modelType: 'runtime',
                options: {},
              },
            },
          }}
        >
          <ProjectAiDesktopComposer
            services={
              {
                modelApi: {
                  listModels: vi.fn().mockResolvedValue({ data: models }),
                },
              } as unknown as WorkbenchServices
            }
            projectId="project-two"
            issues={[]}
            activeRun={null}
            running={false}
            value=""
            onChange={() => undefined}
            onSubmit={onSubmit}
            onStop={vi.fn()}
            disabled={false}
            busy={false}
            placeholder="Ask project AI"
          />
        </AppPreferencesContext.Provider>
      )
    })

    await waitForText(container, '[data-testid="selected-model"]', 'model-two')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="submit"]')?.click()
    })
    expect(onSubmit).toHaveBeenCalledWith('Manage this project', {
      modelName: 'model-two',
      modelType: 'runtime',
      options: expect.objectContaining({
        collaborationMode: 'default',
        codexProviderId: 'openai',
        codexProviderName: 'OpenAI',
        codexProviderType: 'official',
      }),
    })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="select-first-model"]')?.click()
    })
    expect(updateAppPreferences).toHaveBeenLastCalledWith({
      projectAiModelSelection: expect.objectContaining({
        modelName: 'model-one',
        modelType: 'public',
      }),
    })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="select-reasoning"]')?.click()
    })
    expect(updateAppPreferences).toHaveBeenLastCalledWith({
      projectAiModelSelection: expect.objectContaining({
        modelName: 'model-one',
        modelType: 'public',
        options: expect.objectContaining({ reasoning: 'high' }),
      }),
    })
  })
})

async function waitForText(container: HTMLElement, selector: string, text: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (container.querySelector(selector)?.textContent === text) return
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
    })
  }
  throw new Error(`Element ${selector} did not contain ${text}`)
}
