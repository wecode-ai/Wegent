import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import {
  createQuickPhrasePreferencesStore,
  defaultQuickPhrases,
} from '@wegent/chat-core/composer-quick-phrases'
import { BrowserQuickPhraseMenu } from '../../../packages/collaboration/src/issue-detail/BrowserQuickPhraseMenu'
import { createCollaborationTranslator } from '../../../packages/collaboration/src/i18n'

const translate = createCollaborationTranslator('en')

it('loads shared preferences once for multiple browser menus', async () => {
  const load = vi.fn().mockResolvedValue(defaultQuickPhrases)
  const store = createQuickPhrasePreferencesStore({ load, save: vi.fn() })
  render(
    <>
      <BrowserQuickPhraseMenu
        store={store}
        translate={translate}
        disabled={false}
        onSelect={vi.fn()}
      />
      <BrowserQuickPhraseMenu
        store={store}
        translate={translate}
        disabled={false}
        onSelect={vi.fn()}
      />
    </>
  )
  await waitFor(() => {
    for (const button of screen.getAllByTestId('quick-phrase-button')) expect(button).toBeEnabled()
  })
  expect(load).toHaveBeenCalledOnce()
})

it('isolates the preferences modal and releases it on cancellation and unmount', async () => {
  const user = userEvent.setup()
  const store = createQuickPhrasePreferencesStore({
    load: async () => defaultQuickPhrases,
    save: vi.fn(),
  })
  const { unmount } = render(
    <BrowserQuickPhraseMenu
      store={store}
      translate={translate}
      disabled={false}
      onSelect={vi.fn()}
    />
  )
  const trigger = screen.getByTestId('quick-phrase-button')
  const open = async () => {
    await waitFor(() => expect(trigger).toBeEnabled())
    await user.click(trigger)
    await user.click(screen.getByTestId('manage-quick-phrases-button'))
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
    await waitFor(() => expect(trigger.closest('[inert], [aria-hidden="true"]')).not.toBeNull())
  }
  await open()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(trigger.closest('[inert], [aria-hidden="true"]')).toBeNull()
  await open()
  unmount()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('keeps a replaced preferences source separate from a late initial read', async () => {
  let finish!: (phrases: typeof defaultQuickPhrases) => void
  const oldStore = createQuickPhrasePreferencesStore({
    load: () =>
      new Promise(resolve => {
        finish = resolve
      }),
    save: vi.fn(),
  })
  const newStore = createQuickPhrasePreferencesStore({
    load: async () => [{ ...defaultQuickPhrases[0], id: 'new-source', title: 'New source phrase' }],
    save: vi.fn(),
  })
  const { rerender } = render(
    <BrowserQuickPhraseMenu
      store={oldStore}
      translate={translate}
      disabled={false}
      onSelect={vi.fn()}
    />
  )
  await act(async () => {})
  rerender(
    <BrowserQuickPhraseMenu
      store={newStore}
      translate={translate}
      disabled={false}
      onSelect={vi.fn()}
    />
  )
  await waitFor(() => expect(screen.getByTestId('quick-phrase-button')).toBeEnabled())
  await act(async () => finish(defaultQuickPhrases))
  await userEvent.click(screen.getByTestId('quick-phrase-button'))
  expect(screen.getByTestId('quick-phrase-option-new-source')).toHaveTextContent(
    'New source phrase'
  )
  expect(
    screen.queryByTestId(`quick-phrase-option-${defaultQuickPhrases[0].id}`)
  ).not.toBeInTheDocument()
})
