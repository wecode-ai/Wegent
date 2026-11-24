// @vitest-environment jsdom
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Package } from 'lucide-react'
import { ComposerMentionMenu, type MentionMenuRow } from './ComposerMentionMenu'
import { SlashCommandMenu } from './SlashCommandMenu'
import { SlashModelMenu } from './SlashModelMenu'
import { ComposerAutocompletePopup } from './ComposerAutocompletePopup'
import { createCollaborationTranslator } from '../i18n'
import type { SlashCommand } from './composerAutocomplete'
import type { UnifiedModel } from '@wegent/chat-core/models'

const t = createCollaborationTranslator('en')

describe('shared autocomplete menus without desktop imports', () => {
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })
  const element = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
  async function click(id: string) {
    await act(async () => element(id).click())
  }

  it('preserves command payloads and uses the supplied plugin icon renderer', async () => {
    const app = { id: 'plugin', name: 'Plugin' }
    const commands: SlashCommand<typeof app>[] = [
      {
        id: 'installed',
        title: 'Installed plugin',
        app,
        Icon: Package,
        testId: 'installed',
      },
      {
        id: 'disabled',
        title: 'Unavailable',
        enabled: false,
        Icon: Package,
        testId: 'disabled',
      },
    ]
    const select = vi.fn()
    const retry = vi.fn()
    await act(async () =>
      root.render(
        <SlashCommandMenu
          commands={commands}
          selectedIndex={0}
          className=""
          title="Commands"
          noResultsLabel="No results"
          loadingSkills={false}
          skillLoadError
          skillGroupLabel="Skills"
          skillLoadingLabel="Loading"
          skillLoadErrorLabel="Cannot load skills"
          skillRetryLabel="Retry"
          onSelectCommand={select}
          onHighlightCommand={vi.fn()}
          onRetrySkills={retry}
          renderAppIcon={command => <span data-testid="host-plugin-icon">{command.app!.name}</span>}
        />
      )
    )
    expect(element('host-plugin-icon').textContent).toBe('Plugin')
    const editor = document.createElement('div')
    editor.contentEditable = 'true'
    editor.tabIndex = 0
    container.append(editor)
    editor.focus()
    const pointer = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
    })
    await act(async () => {
      element('slash-command-option-installed').dispatchEvent(pointer)
    })
    expect(pointer.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(editor)
    await click('slash-command-option-disabled')
    expect(select).not.toHaveBeenCalled()
    await click('slash-command-option-installed')
    expect(select).toHaveBeenCalledWith(commands[0])
    await click('slash-command-skill-load-error')
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('keeps unavailable file picking disabled and selects the original external row', async () => {
    const rows: MentionMenuRow[] = [
      { kind: 'files-action' },
      {
        kind: 'external',
        candidate: {
          id: 'agent',
          type: 'agent',
          title: 'Reviewer',
          metaLabel: 'Agent',
        },
      },
    ]
    const select = vi.fn()
    await act(async () =>
      root.render(
        <ComposerMentionMenu
          translate={t}
          menuRef={createRef()}
          rows={rows}
          selectedIndex={0}
          className=""
          mentionMode
          loading={false}
          error={false}
          canBrowseFiles={false}
          onRetry={vi.fn()}
          onHighlight={vi.fn()}
          onSelect={select}
        />
      )
    )
    expect(element('mention-files-action').getAttribute('disabled')).not.toBeNull()
    await click('mention-files-action')
    expect(select).not.toHaveBeenCalled()
    await click('external-mention-agent-agent')
    expect(select).toHaveBeenCalledWith(1)
    expect(element('local-skill-autocomplete').textContent).not.toContain('workbench.')
  })

  it('reports unavailable models, preserves full selected records and ignores IME confirmation', async () => {
    const models: UnifiedModel[] = [
      {
        name: 'gpt-available',
        displayName: 'Available model',
        type: 'runtime',
        provider: 'provider-a',
      },
      {
        name: 'gpt-unavailable',
        displayName: 'Unavailable model',
        type: 'runtime',
        compatibilityDisabled: true,
      },
    ]
    const select = vi.fn()
    const blocked = vi.fn()
    await act(async () =>
      root.render(
        <ComposerAutocompletePopup
          anchor={container}
          editorRef={{ current: null }}
          label="Models"
          className=""
          onClose={vi.fn()}
        >
          <SlashModelMenu
            translate={t}
            models={models}
            selectedModel={null}
            selectedModelOptions={{}}
            query=""
            selectedIndex={0}
            className=""
            searchPlaceholder="Search models"
            noResultsLabel="No models"
            onQueryChange={vi.fn()}
            onSelectedIndexChange={vi.fn()}
            onSelectModel={select}
            onBlockedModelSelect={blocked}
            onClose={vi.fn()}
            getCompatibilityDisabledMessage={() => 'Unavailable here'}
          />
        </ComposerAutocompletePopup>
      )
    )
    expect(document.activeElement).toBe(element('slash-model-search-input'))
    await act(async () =>
      element('slash-model-search-input').dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          keyCode: 229,
          isComposing: true,
          bubbles: true,
        })
      )
    )
    expect(select).not.toHaveBeenCalled()
    await click('slash-model-option-gpt-unavailable')
    expect(blocked).toHaveBeenCalledWith(models[1], 'Unavailable here')
    expect(select).not.toHaveBeenCalled()
    await click('slash-model-option-gpt-available')
    expect(select).toHaveBeenCalledWith(models[0])
  })
  it('keeps the editor focused and delegates candidate dismissal to the SDK popup', async () => {
    const editor = document.createElement('div')
    editor.contentEditable = 'true'
    editor.tabIndex = 0
    editor.textContent = '/plugin'
    document.body.append(editor)
    editor.focus()
    const range = document.createRange()
    range.setStart(editor.firstChild!, 3)
    range.collapse(true)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    const close = vi.fn()
    try {
      await act(async () =>
        root.render(
          <ComposerAutocompletePopup
            anchor={editor}
            editorRef={{ current: editor }}
            label="Candidates"
            className=""
            onClose={close}
          >
            <button data-testid="candidate">Candidate</button>
          </ComposerAutocompletePopup>
        )
      )
      expect(document.activeElement).toBe(editor)
      expect(window.getSelection()!.anchorOffset).toBe(3)
      expect(window.getSelection()!.anchorNode).toBe(editor.firstChild)
      expect(element('composer-autocomplete-popup').getAttribute('data-side')).toBeTruthy()
      await act(async () =>
        editor.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      )
      expect(close).not.toHaveBeenCalled()
      await act(async () =>
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      )
      expect(close).toHaveBeenCalledWith(true)
      close.mockClear()
      await act(async () =>
        document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      )
      expect(close).toHaveBeenCalledWith(false)
    } finally {
      editor.remove()
    }
  })
})
