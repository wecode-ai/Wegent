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

const modelExecutionMock = vi.hoisted(() => ({
  getModelExecutionOverride: vi.fn(),
}))
vi.mock('@/features/cloud-connection/modelExecution', () => modelExecutionMock)

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

import { ModelSelector } from './ModelSelector'

const SHELL_LEFT = 800
const WINDOW_INNER_WIDTH = 1200
const WINDOW_INNER_HEIGHT = 900

function createShellElement(options?: { hidden?: boolean }): HTMLDivElement {
  const shell = document.createElement('div')
  shell.id = 'right-workspace-panel-shell'
  shell.setAttribute('data-testid', 'right-workspace-panel-shell')
  if (options?.hidden) {
    shell.setAttribute('aria-hidden', 'true')
  } else {
    shell.setAttribute('aria-hidden', 'false')
  }
  shell.getBoundingClientRect = () =>
    ({
      top: 0,
      left: options?.hidden ? WINDOW_INNER_WIDTH : SHELL_LEFT,
      right: WINDOW_INNER_WIDTH,
      bottom: WINDOW_INNER_HEIGHT,
      width: options?.hidden ? 0 : WINDOW_INNER_WIDTH - SHELL_LEFT,
      height: WINDOW_INNER_HEIGHT,
      x: options?.hidden ? WINDOW_INNER_WIDTH : SHELL_LEFT,
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
    modelExecutionMock.getModelExecutionOverride.mockReturnValue(undefined)
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

    expect(await screen.findByTestId(`model-option-${SAMPLE_MODEL.name}`)).toBeInTheDocument()
    expect(screen.queryByTestId('model-selector-family-submenu')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-family-codex-official')).not.toBeInTheDocument()
  })

  test('shows family entries before model options when there are multiple families', async () => {
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

    expect(await screen.findByTestId('model-family-codex-official')).toHaveTextContent('我的CodeX')
    expect(screen.getByTestId('model-family-claude')).toBeInTheDocument()
    expect(screen.getByTestId('model-selector-submenu')).not.toHaveClass('min-h-48')
    expect(screen.queryByTestId(`model-option-${SAMPLE_MODEL.name}`)).not.toBeInTheDocument()

    fireEvent.mouseEnter(screen.getByTestId('model-family-claude'))

    const familySubmenu = await screen.findByTestId('model-selector-family-submenu')
    expect(familySubmenu).toHaveTextContent('Claude')
    expect(familySubmenu).not.toHaveClass('min-h-48')
    expect(screen.getByTestId(`model-option-${SECOND_FAMILY_MODEL.name}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`model-option-${SAMPLE_MODEL.name}`)).not.toBeInTheDocument()
  })

  test('keeps the family model submenu above the viewport bottom', async () => {
    createShellElement({ hidden: true })
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect
    const originalScrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollHeight'
    )
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.getAttribute('data-testid') === 'model-selector-menu') {
        return {
          top: 600,
          left: 600,
          right: 856,
          bottom: 856,
          width: 256,
          height: 256,
          x: 600,
          y: 600,
          toJSON: () => {},
        } as DOMRect
      }
      if (this.getAttribute('data-testid') === 'model-selector-family-submenu') {
        return {
          top: 800,
          left: 888,
          right: 1176,
          bottom: 1040,
          width: 288,
          height: 240,
          x: 888,
          y: 800,
          toJSON: () => {},
        } as DOMRect
      }
      return originalGetBoundingClientRect.call(this)
    }
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return this.getAttribute('data-testid') === 'model-selector-family-submenu' ? 240 : 0
      },
    })

    try {
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
      fireEvent.mouseEnter(await screen.findByTestId('model-family-claude'))

      const familySubmenu = await screen.findByTestId('model-selector-family-submenu')
      const wrapper = screen.getByTestId('model-selector-menu').parentElement
      await waitFor(() => {
        expect(
          parseInt(wrapper!.style.top, 10) + parseInt(familySubmenu.style.top, 10) + 240
        ).toBeLessThanOrEqual(WINDOW_INNER_HEIGHT - 16)
      })
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect
      if (originalScrollHeight) {
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight)
      }
    }
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
