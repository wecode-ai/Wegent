import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { UnifiedModel } from '@/types/api'

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

import { ModelSelector } from './ModelSelector'
import { getDesktopModelSelectorCollisionPadding } from './model-selector-layout'

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
  provider: 'local',
  config: {
    ui: { family: 'claude' },
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

  test('keeps the hidden width measurement inside the toolbar bounds', () => {
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

    expect(screen.getByTestId('model-selector-button')).toHaveClass('text-sm', 'font-normal')
    expect(screen.getByTestId('model-selector-button')).toHaveAttribute(
      'data-model-provider-id',
      'openai'
    )
    expect(screen.getByTestId('model-selector-width-measure')).toHaveClass(
      'left-0',
      'top-0',
      'text-sm',
      'font-normal'
    )
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

  test('expands model options directly when there is only one family', async () => {
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
    fireEvent.mouseEnter(await screen.findByTestId('model-control-menu-model'))

    expect(await screen.findByTestId(`model-option-${SAMPLE_MODEL.name}`)).toHaveAttribute(
      'data-model-provider-id',
      'openai'
    )
    expect(screen.queryByTestId('model-selector-family-submenu')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-family-codex-official')).not.toBeInTheDocument()
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
        models={[SAMPLE_MODEL, SECOND_FAMILY_MODEL]}
        selectedModel={SAMPLE_MODEL}
        selectedModelOptions={{}}
        disabled={false}
        onSelectModel={vi.fn()}
        onSelectModelOption={vi.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('model-selector-button'))
    fireEvent.mouseEnter(await screen.findByTestId('model-control-menu-model'))

    const submenu = await screen.findByTestId('model-selector-submenu')
    expect(submenu).toHaveTextContent('我的CodeX')
    expect(submenu).toHaveTextContent('Claude')
    expect(screen.getByTestId(`model-option-${SECOND_FAMILY_MODEL.name}`)).toBeInTheDocument()
    expect(screen.getByTestId(`model-option-${SAMPLE_MODEL.name}`)).toBeInTheDocument()
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
    fireEvent.mouseEnter(await screen.findByTestId('model-control-menu-model'))
    fireEvent.click(await screen.findByTestId(`model-option-${SAMPLE_MODEL.name}`))

    expect(onSelectModel).toHaveBeenCalledWith(SAMPLE_MODEL)
    expect(screen.queryByTestId('model-selector-menu')).not.toBeInTheDocument()
    await waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false, 'selection'))
    expect(embeddedBrowserOcclusionMock).toHaveBeenLastCalledWith('model-selector-flyout', false)
  })

  test('uses the available viewport height for a long model list', async () => {
    createShellElement({ hidden: true })
    const models = Array.from({ length: 30 }, (_, index) => ({
      ...SAMPLE_MODEL,
      name: `gpt-5.5-${index}`,
      modelId: `gpt-5.5-${index}`,
      displayName: `GPT 5.5 ${index}`,
    }))

    render(
      <ModelSelector
        models={models}
        selectedModel={models[0]}
        selectedModelOptions={{}}
        disabled={false}
        onSelectModel={vi.fn()}
        onSelectModelOption={vi.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('model-selector-button'))
    fireEvent.mouseEnter(await screen.findByTestId('model-control-menu-model'))

    const submenu = await screen.findByTestId('model-selector-submenu')
    expect(submenu.style.maxHeight).toBe(
      'min(var(--radix-popover-content-available-height), calc(100vh - 16px))'
    )
  })

  test('uses the Codex flyout viewport contract in a narrow viewport', async () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 500,
    })
    createShellElement({ hidden: true })
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      const testId = this.getAttribute('data-testid')
      if (testId === 'model-selector-button') {
        return {
          top: 500,
          left: 230,
          right: 470,
          bottom: 540,
          width: 240,
          height: 40,
          x: 230,
          y: 500,
          toJSON: () => {},
        } as DOMRect
      }
      if (testId === 'model-selector-menu') {
        return {
          top: 300,
          left: 246,
          right: 470,
          bottom: 500,
          width: 224,
          height: 200,
          x: 246,
          y: 300,
          toJSON: () => {},
        } as DOMRect
      }
      if (testId === 'model-control-menu-model') {
        return {
          top: 308,
          left: 254,
          right: 462,
          bottom: 340,
          width: 208,
          height: 32,
          x: 254,
          y: 308,
          toJSON: () => {},
        } as DOMRect
      }
      if (testId === 'model-selector-submenu') {
        return {
          top: 308,
          left: 0,
          right: 280,
          bottom: 608,
          width: 280,
          height: 300,
          x: 0,
          y: 308,
          toJSON: () => {},
        } as DOMRect
      }
      return originalGetBoundingClientRect.call(this)
    }

    try {
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
      fireEvent.mouseEnter(await screen.findByTestId('model-control-menu-model'))

      const submenu = await screen.findByTestId('model-selector-submenu')
      await waitFor(() => expect(submenu).toHaveAttribute('data-side', 'left'))
      expect(submenu).toHaveAttribute('data-align', 'start')
      expect(submenu.style.width).toBe('280px')
      expect(submenu.style.maxWidth).toBe(
        'min(var(--radix-popover-content-available-width), calc(100vw - 16px))'
      )
      expect(submenu.parentElement?.parentElement).toBe(document.body)
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect
    }
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
    fireEvent.mouseEnter(await screen.findByTestId('model-control-menu-model'))

    const submenu = await screen.findByTestId('model-selector-submenu')
    expect(submenu.style.width).toBe('280px')
    expect(submenu).toHaveAttribute('data-embedded-browser-occlusion')
    expect(embeddedBrowserOcclusionMock).toHaveBeenLastCalledWith('model-selector-flyout', true)

    fireEvent.click(screen.getByTestId('model-selector-button'))
    expect(embeddedBrowserOcclusionMock).toHaveBeenLastCalledWith('model-selector-flyout', false)
  })

  test('caps the trigger width when maxClosedWidth is provided', () => {
    createShellElement({ hidden: true })

    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.getAttribute('data-testid') === 'model-selector-button') {
        return {
          top: 500,
          left: 700,
          right: 940,
          bottom: 540,
          width: 240,
          height: 40,
          x: 700,
          y: 500,
          toJSON: () => {},
        } as DOMRect
      }
      if (this.getAttribute('aria-hidden') === 'true' && this.tagName === 'SPAN') {
        return {
          top: 0,
          left: 0,
          right: 300,
          bottom: 0,
          width: 300,
          height: 0,
          x: 0,
          y: 0,
          toJSON: () => {},
        } as DOMRect
      }
      return originalGetBoundingClientRect.call(this)
    }

    try {
      render(
        <ModelSelector
          models={[SAMPLE_MODEL]}
          selectedModel={SAMPLE_MODEL}
          selectedModelOptions={{}}
          disabled={false}
          onSelectModel={vi.fn()}
          onSelectModelOption={vi.fn()}
          maxClosedWidth={160}
        />
      )

      const button = screen.getByTestId('model-selector-button')
      expect(button.style.getPropertyValue('--model-selector-width')).toBe('160px')
      expect(button.style.width).toBe('var(--model-selector-width, auto)')
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect
    }
  })

  test('keeps the trigger capped when opened with maxClosedWidth', async () => {
    createShellElement({ hidden: true })

    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.getAttribute('data-testid') === 'model-selector-button') {
        return {
          top: 500,
          left: 700,
          right: 940,
          bottom: 540,
          width: 240,
          height: 40,
          x: 700,
          y: 500,
          toJSON: () => {},
        } as DOMRect
      }
      if (this.getAttribute('aria-hidden') === 'true' && this.tagName === 'SPAN') {
        return {
          top: 0,
          left: 0,
          right: 300,
          bottom: 0,
          width: 300,
          height: 0,
          x: 0,
          y: 0,
          toJSON: () => {},
        } as DOMRect
      }
      return originalGetBoundingClientRect.call(this)
    }

    try {
      render(
        <ModelSelector
          models={[SAMPLE_MODEL]}
          selectedModel={SAMPLE_MODEL}
          selectedModelOptions={{}}
          disabled={false}
          onSelectModel={vi.fn()}
          onSelectModelOption={vi.fn()}
          maxClosedWidth={160}
        />
      )

      const button = screen.getByTestId('model-selector-button')
      fireEvent.click(button)
      await waitFor(() => screen.getByTestId('model-selector-menu'))

      expect(button.style.getPropertyValue('--model-selector-width')).toBe('160px')
      expect(button.style.width).toBe('var(--model-selector-width, auto)')
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect
    }
  })

  test('uses the default closed width cap when maxClosedWidth is omitted', () => {
    createShellElement({ hidden: true })

    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.getAttribute('data-testid') === 'model-selector-button') {
        return {
          top: 500,
          left: 700,
          right: 940,
          bottom: 540,
          width: 240,
          height: 40,
          x: 700,
          y: 500,
          toJSON: () => {},
        } as DOMRect
      }
      if (this.getAttribute('aria-hidden') === 'true' && this.tagName === 'SPAN') {
        return {
          top: 0,
          left: 0,
          right: 300,
          bottom: 0,
          width: 300,
          height: 0,
          x: 0,
          y: 0,
          toJSON: () => {},
        } as DOMRect
      }
      return originalGetBoundingClientRect.call(this)
    }

    try {
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
      expect(button.style.getPropertyValue('--model-selector-width')).toBe('208px')
      expect(button.style.width).toBe('var(--model-selector-width, auto)')
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect
    }
  })
})
