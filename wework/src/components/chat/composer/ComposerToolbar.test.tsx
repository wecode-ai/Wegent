import { cleanup, render, screen } from '@testing-library/react'
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

vi.mock('@/hooks/useQuickPhrases', () => ({
  useQuickPhrases: () => [],
}))

vi.mock('@/tauri/appPreferences', () => ({
  getAppPreferences: vi.fn(),
  updateAppPreferences: vi.fn(),
}))

import { ComposerToolbar } from './ComposerToolbar'

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

function mockToolbarWidth(width: number) {
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.getAttribute('data-testid') === 'composer-toolbar') {
      return {
        top: 0,
        left: 0,
        right: width,
        bottom: 40,
        width,
        height: 40,
        x: 0,
        y: 0,
        toJSON: () => {},
      } as DOMRect
    }
    return originalGetBoundingClientRect.call(this)
  }
  return () => {
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect
  }
}

describe('ComposerToolbar', () => {
  const originalResizeObserver = globalThis.ResizeObserver

  beforeEach(() => {
    isMobileMock.mockReturnValue(false)
    configuredKeybindingMock.mockReturnValue(null)
    modelExecutionMock.getModelExecutionOverride.mockReturnValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    globalThis.ResizeObserver = originalResizeObserver
  })

  test('shows the QuickPhraseMenu label when toolbar is wide', () => {
    const restoreRect = mockToolbarWidth(600)
    globalThis.ResizeObserver = class ResizeObserverMock {
      observe() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver

    render(
      <ComposerToolbar
        canSend={false}
        models={[SAMPLE_MODEL]}
        selectedModel={SAMPLE_MODEL}
        selectedModelOptions={{}}
        isModelSelectionReady
        onSelectModel={() => {}}
        onFileSelect={() => {}}
        onQuickPhraseSelect={() => {}}
        onSubmit={() => {}}
      />
    )

    const button = screen.getByTestId('quick-phrase-button')
    expect(button).toHaveTextContent('快捷短语')
    restoreRect()
  })

  test('collapses the QuickPhraseMenu label when toolbar is narrow', () => {
    const restoreRect = mockToolbarWidth(475)
    globalThis.ResizeObserver = class ResizeObserverMock {
      observe() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver

    render(
      <ComposerToolbar
        canSend={false}
        models={[SAMPLE_MODEL]}
        selectedModel={SAMPLE_MODEL}
        selectedModelOptions={{}}
        isModelSelectionReady
        onSelectModel={() => {}}
        onFileSelect={() => {}}
        onQuickPhraseSelect={() => {}}
        onSubmit={() => {}}
      />
    )

    const button = screen.getByTestId('quick-phrase-button')
    expect(button).not.toHaveTextContent('快捷短语')
    restoreRect()
  })
})
