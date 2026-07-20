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

  test('uses the viewport right edge when the right workspace panel is collapsed', async () => {
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

    const button = screen.getByTestId('model-selector-button')
    setButtonRect(button, 1150)
    fireEvent.click(button)

    const menu = await waitFor(() => screen.getByTestId('model-selector-menu'))
    const wrapper = menu.parentElement
    expect(wrapper).not.toBeNull()
    const left = parseInt(wrapper!.style.left, 10)
    expect(left).toBeGreaterThan(SHELL_LEFT - 16)
  })
})
