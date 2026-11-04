import { render, screen } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComposerToolbar } from './ComposerToolbar'

vi.mock('@wegent/collaboration/controls/platform', () => ({
  getPlatform: vi.fn(() => 'mac'),
}))

vi.mock('./QuickPhraseMenu', () => ({
  QuickPhraseMenu: () => <span data-testid="quick-phrase-layout">icon</span>,
}))

vi.mock('./ModelSelector', () => ({
  ModelSelector: () => <span data-testid="model-selector-button">model</span>,
}))

vi.mock('@/features/dsh-runtime/DshContributionSlotSurface', () => ({
  DshContributionSlotSurface: ({
    props,
  }: {
    props: { onActiveChange: (active: boolean) => void }
  }) => {
    const [active, setActive] = useState(false)
    const { onActiveChange } = props
    useEffect(() => () => onActiveChange(false), [onActiveChange])
    return (
      <button
        data-testid="test-voice-input"
        onClick={() => {
          setActive(!active)
          onActiveChange(!active)
        }}
      >
        Voice
      </button>
    )
  },
}))

vi.mock('./DrawingAttachmentDialog', () => ({
  DrawingAttachmentDialog: ({
    onAttach,
    onClose,
  }: {
    onAttach: (file: File) => void
    onClose: () => void
  }) => (
    <div data-testid="drawing-attachment-dialog">
      <button
        data-testid="drawing-confirm-button"
        onClick={() => {
          onAttach(new File(['png'], 'drawing.png', { type: 'image/png' }))
          onClose()
        }}
      >
        Attach
      </button>
      <button data-testid="drawing-cancel-button" onClick={onClose}>
        Cancel
      </button>
    </div>
  ),
}))

describe('ComposerToolbar', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders the unavailable model selector after the catalog has returned models', () => {
    const unavailableModel = {
      name: 'codex-official-unavailable',
      type: 'runtime' as const,
      displayName: 'CodeX 模型不可用',
      provider: 'local' as const,
      compatibilityDisabled: true,
      compatibilityDisabledReason: 'unavailable' as const,
    }

    render(
      <ComposerToolbar
        canSend={false}
        models={[unavailableModel]}
        selectedModel={null}
        activeModel={unavailableModel}
        selectedModelOptions={{}}
        isModelSelectionReady={false}
        onSelectModel={vi.fn()}
        onSelectModelOption={vi.fn()}
        onFileSelect={vi.fn()}
        onQuickPhraseSelect={vi.fn()}
        onInsertPluginReference={vi.fn()}
        onSubmit={vi.fn()}
      />
    )

    expect(screen.getByTestId('model-selector-button')).toBeInTheDocument()
    expect(screen.queryByTestId('model-selector-loading')).not.toBeInTheDocument()
  })
})
