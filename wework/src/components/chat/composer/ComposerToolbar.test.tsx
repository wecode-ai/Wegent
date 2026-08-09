import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComposerToolbar } from './ComposerToolbar'

let resizeCallback: ResizeObserverCallback | null = null

vi.mock('./QuickPhraseMenu', () => ({
  QuickPhraseMenu: () => <span data-testid="quick-phrase-layout">icon</span>,
}))

vi.mock('./ModelSelector', () => ({
  ModelSelector: () => <span data-testid="model-selector-button">model</span>,
}))

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback
  }

  observe() {}

  disconnect() {}
}

describe('ComposerToolbar', () => {
  afterEach(() => {
    resizeCallback = null
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('collapses low-priority labels based on the composer width', () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 600,
      height: 32,
      top: 0,
      right: 600,
      bottom: 32,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    render(
      <ComposerToolbar
        canSend={false}
        models={[]}
        selectedModel={null}
        selectedModelOptions={{}}
        isModelSelectionReady
        onSelectModel={vi.fn()}
        onSelectModelOption={vi.fn()}
        onFileSelect={vi.fn()}
        onQuickPhraseSelect={vi.fn()}
        onSubmit={vi.fn()}
      />
    )

    expect(screen.getByTestId('composer-toolbar')).toHaveAttribute('data-compact', 'false')
    expect(screen.getByTestId('quick-phrase-layout')).toHaveTextContent('icon')

    act(() => {
      resizeCallback?.(
        [{ contentRect: { width: 440 } } as ResizeObserverEntry],
        {} as ResizeObserver
      )
    })

    expect(screen.getByTestId('composer-toolbar')).toHaveAttribute('data-compact', 'true')
    expect(screen.getByTestId('quick-phrase-layout')).toHaveTextContent('icon')
  })

  it('collapses the plugin picker trigger to an icon once a conversation has started', () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 600,
      height: 32,
      top: 0,
      right: 600,
      bottom: 32,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    const { rerender } = render(
      <ComposerToolbar
        canSend={false}
        models={[]}
        selectedModel={null}
        selectedModelOptions={{}}
        isModelSelectionReady
        onSelectModel={vi.fn()}
        onSelectModelOption={vi.fn()}
        onFileSelect={vi.fn()}
        onQuickPhraseSelect={vi.fn()}
        onSubmit={vi.fn()}
      />
    )

    expect(screen.getByTestId('composer-plugin-picker-button')).toHaveClass('h-8')

    rerender(
      <ComposerToolbar
        canSend={false}
        models={[]}
        selectedModel={null}
        selectedModelOptions={{}}
        isModelSelectionReady
        pluginPickerIconOnly
        onSelectModel={vi.fn()}
        onSelectModelOption={vi.fn()}
        onFileSelect={vi.fn()}
        onQuickPhraseSelect={vi.fn()}
        onSubmit={vi.fn()}
      />
    )

    expect(screen.getByTestId('composer-plugin-picker-button')).toHaveClass('h-7')
  })
})
