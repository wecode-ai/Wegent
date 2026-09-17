import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPlatform } from '@/lib/platform'
import { ComposerToolbar } from './ComposerToolbar'

let resizeCallback: ResizeObserverCallback | null = null

vi.mock('@/lib/platform', () => ({
  getPlatform: vi.fn(() => 'mac'),
}))

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
    expect(screen.getByTestId('composer-extension-actions')).toBeInTheDocument()
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

  it('keeps the expanded plugin picker until the toolbar itself is compact', () => {
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

  it('places the icon-only permission control before context usage', () => {
    render(
      <ComposerToolbar
        canSend={false}
        models={[]}
        selectedModel={null}
        selectedModelOptions={{ permissionMode: 'full-access' }}
        isModelSelectionReady
        contextUsage={{
          total: {
            totalTokens: 15_000,
            inputTokens: 12_000,
            cachedInputTokens: 2_000,
            outputTokens: 3_000,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 8_000,
            inputTokens: 7_000,
            cachedInputTokens: 1_000,
            outputTokens: 1_000,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 258_000,
        }}
        onSelectModel={vi.fn()}
        onSelectModelOption={vi.fn()}
        onFileSelect={vi.fn()}
        onQuickPhraseSelect={vi.fn()}
        onSubmit={vi.fn()}
      />
    )

    const permission = screen.getByTestId('permission-mode-menu-button')
    const contextUsage = screen.getByTestId('context-usage-indicator')
    expect(permission).toHaveTextContent('')
    expect(permission.compareDocumentPosition(contextUsage)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('reserves feature widths and lets model actions use the remaining toolbar space', () => {
    render(
      <ComposerToolbar
        canSend={false}
        models={[]}
        selectedModel={null}
        selectedModelOptions={{}}
        isModelSelectionReady
        goalDraftActive
        onSelectModel={vi.fn()}
        onSelectModelOption={vi.fn()}
        onFileSelect={vi.fn()}
        onQuickPhraseSelect={vi.fn()}
        onSubmit={vi.fn()}
      />
    )

    const toolbar = screen.getByTestId('composer-toolbar')
    const features = toolbar.querySelector('[data-composer-toolbar-group="features"]')
    const actions = toolbar.querySelector('[data-composer-toolbar-group="actions"]')
    const goalPill = screen.getByTestId('goal-draft-pill')

    expect(toolbar).toHaveClass('flex-wrap', 'gap-x-2', 'gap-y-1')
    expect(features).toHaveClass('min-w-0', 'max-w-full', 'flex-wrap', 'gap-x-2', 'gap-y-1')
    expect(features).not.toHaveClass('flex-auto')
    expect(actions).toHaveClass('ml-auto', 'min-w-40', 'flex-1', 'justify-end')
    expect(goalPill).toHaveClass('min-w-8', 'max-w-full', 'shrink', 'overflow-hidden')
    expect(goalPill.querySelector('span')).toHaveClass('min-w-0', 'truncate')
  })

  it.each([
    ['mac', '⌘'],
    ['win', 'Ctrl'],
    ['linux', 'Ctrl'],
  ] as const)('shows the configured send shortcut on %s', async (platform, modifier) => {
    vi.mocked(getPlatform).mockReturnValue(platform)

    render(
      <ComposerToolbar
        canSend
        isStreaming
        sendKey="cmd_enter"
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

    await userEvent.click(screen.getByTestId('send-mode-menu-button'))

    const sendAfterTurnOption = screen.getByTestId('send-after-turn-option')
    const guideCurrentTurnOption = screen.getByTestId('guide-current-turn-option')
    expect(sendAfterTurnOption).toHaveTextContent(modifier)
    expect(sendAfterTurnOption.querySelector('.lucide-corner-down-left')).toBeInTheDocument()
    expect(guideCurrentTurnOption.querySelector('.lucide-corner-down-left')).not.toBeInTheDocument()
  })

  it('assigns the configured send shortcut only to the selected follow-up behavior', async () => {
    vi.mocked(getPlatform).mockReturnValue('mac')

    render(
      <ComposerToolbar
        canSend
        isStreaming
        sendKey="cmd_enter"
        followUpBehavior="guide"
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

    await userEvent.click(screen.getByTestId('send-mode-menu-button'))

    const sendAfterTurnOption = screen.getByTestId('send-after-turn-option')
    const guideCurrentTurnOption = screen.getByTestId('guide-current-turn-option')
    expect(sendAfterTurnOption.querySelector('.lucide-corner-down-left')).not.toBeInTheDocument()
    expect(guideCurrentTurnOption).toHaveTextContent('⌘')
    expect(guideCurrentTurnOption.querySelector('.lucide-corner-down-left')).toBeInTheDocument()
  })
})
