import { CloudTodoModal } from '@/features/todo/CloudTodoModal'
import type { UnifiedModel } from '@/types/api'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const isMobileMock = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: isMobileMock,
}))

const configuredKeybindingMock = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useConfiguredKeybinding', () => ({
  useConfiguredKeybinding: configuredKeybindingMock,
}))

const navigateToMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/navigation', () => ({
  navigateTo: navigateToMock,
}))

const embeddedBrowserOcclusionMock = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useEmbeddedBrowserOcclusion', () => ({
  useEmbeddedBrowserOcclusion: embeddedBrowserOcclusionMock,
}))

const modelExecutionMock = vi.hoisted(() => ({
  supportsResponsesApi: vi.fn().mockReturnValue(false),
}))
vi.mock('@/features/cloud-connection/modelExecution', () => modelExecutionMock)

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

import { useWorkbenchModels } from '@/features/workbench/useWorkbenchModels'
import { getDesktopModelSelectorCollisionPadding } from '@wegent/collaboration/controls/model-selector-layout'
import { ModelSelector } from './ModelSelector'

const SHELL_LEFT = 800
const WINDOW_INNER_WIDTH = 1200
const WINDOW_INNER_HEIGHT = 900

function createShellElement(options?: { hidden?: boolean; left?: number }): HTMLDivElement {
  const shell = document.createElement('div')
  shell.id = 'right-workspace-panel-shell'
  shell.setAttribute('data-testid', 'right-workspace-panel-shell')
  if (options?.hidden) {
    shell.setAttribute('aria-hidden', 'true')
  } else {
    shell.setAttribute('aria-hidden', 'false')
  }
  const shellLeft = options?.left ?? SHELL_LEFT
  shell.getBoundingClientRect = () =>
    ({
      top: 0,
      left: options?.hidden ? WINDOW_INNER_WIDTH : shellLeft,
      right: WINDOW_INNER_WIDTH,
      bottom: WINDOW_INNER_HEIGHT,
      width: options?.hidden ? 0 : WINDOW_INNER_WIDTH - shellLeft,
      height: WINDOW_INNER_HEIGHT,
      x: options?.hidden ? WINDOW_INNER_WIDTH : shellLeft,
      y: 0,
      toJSON: () => {},
    }) as DOMRect
  document.body.appendChild(shell)
  return shell
}

function setButtonRect(button: HTMLElement, right = 850) {
  const left = right - 240
  button.getBoundingClientRect = () =>
    ({
      top: 500,
      left,
      right,
      bottom: 540,
      width: 240,
      height: 40,
      x: left,
      y: 500,
      toJSON: () => {},
    }) as DOMRect
}

const SAMPLE_MODEL: UnifiedModel = {
  name: 'gpt-5.5',
  modelId: 'gpt-5.5',
  displayName: 'GPT 5.5',
  type: 'runtime',
  provider: 'local',
  config: {
    codexProviderId: 'openai',
    weworkModelKind: 'codex-official',
    ui: { family: 'codex-official', controls: ['speed'] },
  },
}

const SECOND_FAMILY_MODEL: UnifiedModel = {
  name: 'claude-sonnet',
  modelId: 'claude-sonnet',
  displayName: 'Claude Sonnet',
  type: 'runtime',
  provider: 'cloud',
  config: {
    ui: { family: 'claude' },
  },
}

const CUSTOM_MODEL: UnifiedModel = {
  name: 'custom-model',
  modelId: 'custom-model',
  displayName: 'Custom Model',
  type: 'runtime',
  provider: 'local',
  config: {
    ui: { family: 'custom' },
  },
}

describe('ModelSelector desktop layout', () => {
  const originalInnerWidth = window.innerWidth
  const originalInnerHeight = window.innerHeight

  beforeEach(() => {
    isMobileMock.mockReturnValue(false)
    configuredKeybindingMock.mockReturnValue(null)
    navigateToMock.mockReset()
    embeddedBrowserOcclusionMock.mockClear()
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: WINDOW_INNER_WIDTH,
    })
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: WINDOW_INNER_HEIGHT,
    })
  })

  afterEach(() => {
    cleanup()
    document.querySelectorAll('#right-workspace-panel-shell').forEach(shell => shell.remove())
    vi.restoreAllMocks()
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: originalInnerWidth,
    })
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: originalInnerHeight,
    })
  })

  test('Escape closes the model menu before its containing conversation dialog', () => {
    const onClose = vi.fn()
    render(
      <CloudTodoModal title="Project conversation" onClose={onClose}>
        <ModelSelector
          models={[SAMPLE_MODEL]}
          selectedModel={SAMPLE_MODEL}
          selectedModelOptions={{}}
          onSelectModel={vi.fn()}
          onSelectModelOption={vi.fn()}
        />
      </CloudTodoModal>
    )
    fireEvent.click(screen.getByTestId('model-selector-button'))
    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Project conversation' })).toBeInTheDocument()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  test('asks the user to select a model instead of displaying a default model', () => {
    render(
      <ModelSelector
        models={[SAMPLE_MODEL]}
        selectedModel={null}
        selectedModelOptions={{}}
        disabled={false}
        onSelectModel={vi.fn()}
        onSelectModelOption={vi.fn()}
      />
    )

    expect(screen.getByTestId('model-selector-button')).toHaveTextContent('Select model')
    expect(screen.getByTestId('model-selector-button')).not.toHaveTextContent('默认')
  })

  test('positions the menu to the left of the right workspace panel shell', async () => {
    createShellElement()

    render(
      <ModelSelector
        models={[SAMPLE_MODEL]}
        selectedModel={SAMPLE_MODEL}
        selectedModelOptions={{}}
        disabled={false}
        onSelectModel={vi.fn()}
        onSelectModelOption={vi.fn()}
      />
    )

    const button = screen.getByTestId('model-selector-button')
    setButtonRect(button)
    fireEvent.click(button)

    const menu = await waitFor(() => screen.getByTestId('model-selector-menu'))
    const wrapper = menu.parentElement
    expect(wrapper).not.toBeNull()
    const left = parseInt(wrapper!.style.left, 10)
    expect(left).toBeLessThanOrEqual(SHELL_LEFT - 16)
  })

  test('keeps a menu opened inside the right workspace panel over the panel', async () => {
    const shell = createShellElement()

    render(
      <ModelSelector
        models={[SAMPLE_MODEL]}
        selectedModel={SAMPLE_MODEL}
        selectedModelOptions={{}}
        disabled={false}
        onSelectModel={vi.fn()}
        onSelectModelOption={vi.fn()}
      />,
      { container: shell }
    )

    const button = screen.getByTestId('model-selector-button')
    setButtonRect(button, WINDOW_INNER_WIDTH - 20)
    fireEvent.click(button)

    const menu = await waitFor(() => screen.getByTestId('model-selector-menu'))
    const wrapper = menu.parentElement
    expect(wrapper).not.toBeNull()
    const left = parseInt(wrapper!.style.left, 10)
    expect(left).toBeGreaterThanOrEqual(SHELL_LEFT)
  })

  test('shows the selected model source in the compact slider panel', async () => {
    createShellElement({ hidden: true })

    render(
      <ModelSelector
        models={[SAMPLE_MODEL]}
        selectedModel={SAMPLE_MODEL}
        selectedModelOptions={{}}
        disabled={false}
        onSelectModel={vi.fn()}
        onSelectModelOption={vi.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('model-selector-button'))
    expect(await screen.findByTestId('model-simple-source')).toHaveTextContent('本机 ChatGPT 账户')
    fireEvent.click(await screen.findByTestId('model-advanced-toggle'))

    expect(await screen.findByTestId(`model-option-${SAMPLE_MODEL.name}`)).toHaveAttribute(
      'data-model-provider-id',
      'openai'
    )
    expect(screen.queryByTestId('model-selector-family-submenu')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-family-codex-official')).not.toBeInTheDocument()
  })

  test('opens model options directly when the selected model has no configurable slider', async () => {
    createShellElement({ hidden: true })

    render(
      <ModelSelector
        models={[SECOND_FAMILY_MODEL]}
        selectedModel={SECOND_FAMILY_MODEL}
        selectedModelOptions={{}}
        disabled={false}
        onSelectModel={vi.fn()}
        onSelectModelOption={vi.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('model-selector-button'))

    expect(
      await screen.findByTestId(`model-option-${SECOND_FAMILY_MODEL.name}`)
    ).toBeInTheDocument()
    expect(screen.queryByTestId('model-simple-header')).not.toBeInTheDocument()
  })

  test('opens setup destinations from the empty model menu', async () => {
    createShellElement({ hidden: true })

    render(
      <ModelSelector
        models={[]}
        selectedModel={null}
        selectedModelOptions={{}}
        disabled={false}
        onSelectModel={vi.fn()}
        onSelectModelOption={vi.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('model-selector-button'))
    expect(await screen.findByTestId('model-selector-empty-state')).toHaveTextContent(
      'Add a custom model, or sign in to Wegent to sync cloud models.'
    )

    fireEvent.click(screen.getByTestId('model-selector-add-custom-model'))
    expect(navigateToMock).toHaveBeenCalledWith('/settings/personal/models')
    expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('model-selector-button'))
    fireEvent.click(await screen.findByTestId('model-selector-login-cloud'))
    expect(navigateToMock).toHaveBeenCalledWith('/settings/connections')
    expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()
  })

  test('shows models from every family in the second-level menu', async () => {
    createShellElement({ hidden: true })

    render(
      <ModelSelector
        models={[SAMPLE_MODEL, SECOND_FAMILY_MODEL, CUSTOM_MODEL]}
        selectedModel={SAMPLE_MODEL}
        selectedModelOptions={{}}
        disabled={false}
        onSelectModel={vi.fn()}
        onSelectModelOption={vi.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('model-selector-button'))
    fireEvent.click(await screen.findByTestId('model-advanced-toggle'))

    const menu = await screen.findByTestId('model-selector-menu')
    expect(menu).toHaveTextContent('本机 ChatGPT 账户')
    expect(menu).toHaveTextContent('云端模型')
    expect(menu).toHaveTextContent('自定义模型')
    expect(menu).toHaveTextContent('Claude')
    const localSource = screen.getByTestId('model-source-local-chatgpt')
    const cloudSource = screen.getByTestId('model-source-cloud')
    const customSource = screen.getByTestId('model-source-custom')
    const cloudFamily = screen.getByTestId('model-group-claude')
    const customFamily = screen.getByTestId('model-group-custom')
    expect(localSource.parentElement).toBe(cloudSource.parentElement)
    expect(cloudSource).toContainElement(cloudFamily)
    expect(customSource).toContainElement(customFamily)
    expect(localSource).not.toContainElement(cloudFamily)
    expect(localSource.compareDocumentPosition(cloudSource)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(cloudSource.compareDocumentPosition(customSource)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(screen.getByTestId(`model-option-${SECOND_FAMILY_MODEL.name}`)).toBeInTheDocument()
    expect(screen.getByTestId(`model-option-${SAMPLE_MODEL.name}`)).toBeInTheDocument()
    expect(screen.getByTestId(`model-option-${CUSTOM_MODEL.name}`)).toBeInTheDocument()
  })

  test('closes the picker when model selection is deferred to a confirmation dialog', async () => {
    createShellElement({ hidden: true })
    const onSelectModel = vi.fn().mockReturnValue(false)
    const onOpenChange = vi.fn()

    render(
      <ModelSelector
        models={[SAMPLE_MODEL]}
        selectedModel={SAMPLE_MODEL}
        selectedModelOptions={{}}
        disabled={false}
        onSelectModel={onSelectModel}
        onSelectModelOption={vi.fn()}
        onOpenChange={onOpenChange}
      />
    )

    fireEvent.click(screen.getByTestId('model-selector-button'))
    fireEvent.click(await screen.findByTestId('model-advanced-toggle'))
    fireEvent.click(await screen.findByTestId(`model-option-${SAMPLE_MODEL.name}`))

    expect(onSelectModel).toHaveBeenCalledWith(SAMPLE_MODEL)
    expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()
    await waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false, 'selection'))
    expect(embeddedBrowserOcclusionMock).toHaveBeenLastCalledWith('model-selector-flyout', false)
  })

  test('refreshes on each opening and keeps the menu and selection after a failed refresh', async () => {
    const addedModel = { ...SAMPLE_MODEL, name: 'new-cloud-model', displayName: 'New cloud model' }
    const api = {
      listModels: vi
        .fn()
        .mockResolvedValueOnce({ data: [SAMPLE_MODEL] })
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue({ data: [SAMPLE_MODEL, addedModel] }),
    }
    function ComposerModelMenu() {
      const selection = useWorkbenchModels({
        api,
        locked: false,
        selectionConfig: { modelName: SAMPLE_MODEL.name, modelType: SAMPLE_MODEL.type },
      })
      return (
        <ModelSelector
          models={selection.models}
          selectedModel={selection.selectedModel}
          selectedModelOptions={selection.selectedModelOptions}
          disabled={false}
          onSelectModel={selection.setSelectedModel}
          onSelectModelOption={selection.setSelectedModelOption}
          onOpenChange={open => {
            if (open) selection.refreshModels()
          }}
        />
      )
    }
    render(<ComposerModelMenu />)
    await waitFor(() =>
      expect(screen.getByTestId('model-selector-button')).toHaveTextContent('GPT 5.5')
    )
    fireEvent.click(screen.getByTestId('model-selector-button'))
    await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
    expect(screen.getByTestId('model-selector-button')).toHaveTextContent('Select effort')
    fireEvent.click(screen.getByTestId('model-selector-button'))
    expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('model-selector-button'))
    fireEvent.click(await screen.findByTestId('model-advanced-toggle'))
    expect(await screen.findByTestId('model-option-new-cloud-model')).toBeInTheDocument()
    expect(api.listModels).toHaveBeenCalledTimes(3)
    expect(screen.getByTestId('model-selector-button')).toHaveTextContent('GPT 5.5')
  })

  test('uses the full viewport for Codex flyouts over a narrow browser split', async () => {
    createShellElement({ left: 430 })

    expect(getDesktopModelSelectorCollisionPadding()).toEqual({
      top: 64,
      right: 16,
      bottom: 16,
      left: 16,
    })

    render(
      <ModelSelector
        models={[SAMPLE_MODEL]}
        selectedModel={SAMPLE_MODEL}
        selectedModelOptions={{}}
        disabled={false}
        onSelectModel={vi.fn()}
        onSelectModelOption={vi.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('model-selector-button'))
    fireEvent.click(await screen.findByTestId('model-advanced-toggle'))

    const menu = await screen.findByTestId('model-selector-menu')
    expect(menu.parentElement).toHaveAttribute('data-embedded-browser-occlusion')
    expect(embeddedBrowserOcclusionMock).toHaveBeenLastCalledWith('model-selector-flyout', true)

    fireEvent.click(screen.getByTestId('model-selector-button'))
    expect(embeddedBrowserOcclusionMock).toHaveBeenLastCalledWith('model-selector-flyout', false)
  })
})
