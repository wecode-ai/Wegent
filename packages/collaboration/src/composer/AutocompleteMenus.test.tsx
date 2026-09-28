// @vitest-environment jsdom
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Package } from 'lucide-react'
import { ComposerMentionMenu, type MentionMenuRow } from './ComposerMentionMenu'
import { SlashCommandMenu } from './SlashCommandMenu'
import { SlashModelMenu } from './SlashModelMenu'
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
      { id: 'installed', title: 'Installed plugin', app, Icon: Package, testId: 'installed' },
      { id: 'disabled', title: 'Unavailable', enabled: false, Icon: Package, testId: 'disabled' },
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
        candidate: { id: 'agent', type: 'agent', title: 'Reviewer', metaLabel: 'Agent' },
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
      )
    )
    await act(async () =>
      element('slash-model-menu').dispatchEvent(
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
})
