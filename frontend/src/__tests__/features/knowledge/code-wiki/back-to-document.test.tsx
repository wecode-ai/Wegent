// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Once a conversation started there was no way back to the page.
 *
 * The page is the chat's empty state, and the chat swaps that for the conversation
 * without telling anyone — so the reader lost the document, the outline, and the only
 * route back was the browser's own history.
 *
 * The first fix remounted the chat to reach its empty state again. That discarded the
 * conversation, and it did not even work: the chat reads its task from the URL, so it
 * reloaded the exchange being left. Clearing the URL as well meant a navigation, which
 * re-rendered the whole knowledge page — the list flashed on the way through.
 *
 * The chat is never unmounted now. The page is laid over it, so going back is a
 * repaint: the exchange is still there, and still there to go back to.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CodeWikiReader } from '@/features/knowledge/code-wiki/CodeWikiReader'
import type { KnowledgeBase } from '@/types/knowledge'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const replace = jest.fn()
const push = jest.fn()
let search = ''
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push }),
  usePathname: () => '/knowledge/default/wecode-ai%2FWegent',
  useSearchParams: () => new URLSearchParams(search),
}))

jest.mock('@/contexts/TeamContext', () => ({
  useTeamContext: () => ({ teams: [], isTeamsLoading: false, refreshTeams: jest.fn() }),
}))

jest.mock('@/features/knowledge/code-wiki/useCodeWikiRunStatus', () => ({
  useCodeWikiRunStatus: () => ({ status: null, canRegenerate: true, refresh: jest.fn() }),
}))

jest.mock('@/features/knowledge/code-wiki/RunHistory', () => ({
  RunHistory: () => <div data-testid="run-history" />,
}))

jest.mock('@/features/knowledge/code-wiki/WikiPageContent', () => ({
  WikiPageContent: () => <div data-testid="wiki-page-content" />,
}))

jest.mock('@/apis/code-wiki', () => ({
  codeWikiApi: {
    pages: jest.fn().mockResolvedValue({
      pages: [
        { path: 'index', title: 'Overview', document_id: 1, has_content: true, children: [] },
        { path: 'other', title: 'Other', document_id: 2, has_content: true, children: [] },
      ],
    }),
  },
}))

/**
 * Stands in for the chat, faithfully in the one way that matters: it shows its empty
 * state until a message is sent, and it holds that in its own state — so remounting
 * it puts the empty state back, which is exactly how the real one is returned to.
 */
let arrivesWithConversation = false
jest.mock('@/features/tasks/components/chat', () => {
  const { useState } = jest.requireActual('react')
  return {
    ChatArea: ({ emptyStateContent }: { emptyStateContent?: React.ReactNode }) => {
      const [sent, setSent] = useState(arrivesWithConversation)
      return (
        <div data-testid="chat">
          <button type="button" data-testid="fake-send" onClick={() => setSent(true)} />
          {sent ? <div data-testid="messages" /> : emptyStateContent}
        </div>
      )
    },
  }
})

const WIKI = {
  id: 7,
  name: 'wecode-ai/Wegent',
  namespace: 'default',
  kb_type: 'code_wiki',
  source: { projectName: 'wecode-ai/Wegent' },
  document_count: 2,
  summary_enabled: false,
  max_calls_per_conversation: 10,
  exempt_calls_before_check: 5,
} as unknown as KnowledgeBase

beforeEach(() => {
  arrivesWithConversation = false
  search = ''
})

async function renderReader() {
  render(<CodeWikiReader wiki={WIKI} />)
  await waitFor(() => expect(screen.getByTestId('code-wiki-reader')).toBeInTheDocument())
}

describe('returning to the document', () => {
  it('offers no way back while the page is what is showing', async () => {
    await renderReader()

    expect(screen.getByTestId('wiki-page-content')).toBeInTheDocument()
    expect(screen.queryByTestId('code-wiki-back-to-document')).not.toBeInTheDocument()
  })

  it('keeps showing the page when one is picked and no conversation exists', async () => {
    // The regression the overlay introduced. Picking a page asks for the document,
    // which hid the chat -- and the chat is what renders the document while there is
    // no conversation, so the middle column went blank. Both conditions come from one
    // value now, so they cannot disagree about whether an overlay is happening.
    await renderReader()

    fireEvent.click(screen.getByTestId('wiki-nav-page-other'))

    await waitFor(() => expect(screen.getByTestId('wiki-page-content')).toBeInTheDocument())
    expect(screen.queryByTestId('code-wiki-back-to-chat')).not.toBeInTheDocument()
    // Asserted on the class, not on presence. The pane is hidden by a Tailwind
    // class, and jsdom loads no stylesheet — so "the page is in the document" was
    // true throughout the bug and toBeVisible() would have been too.
    expect(screen.getByTestId('code-wiki-chat-pane')).not.toHaveClass('hidden')
  })

  it('offers a way back once the conversation replaces the page', async () => {
    await renderReader()

    fireEvent.click(screen.getByTestId('fake-send'))

    await waitFor(() =>
      expect(screen.getByTestId('code-wiki-back-to-document')).toBeInTheDocument()
    )
    expect(screen.queryByTestId('wiki-page-content')).not.toBeInTheDocument()
  })

  it('brings the page back without discarding the conversation', async () => {
    await renderReader()
    fireEvent.click(screen.getByTestId('fake-send'))
    await waitFor(() =>
      expect(screen.getByTestId('code-wiki-back-to-document')).toBeInTheDocument()
    )

    fireEvent.click(screen.getByTestId('code-wiki-back-to-document'))

    await waitFor(() => expect(screen.getByTestId('wiki-page-content')).toBeInTheDocument())
    // Still mounted, and still reachable. This is the whole point of laying the page
    // over the chat rather than replacing it.
    expect(screen.getByTestId('messages')).toBeInTheDocument()
    expect(screen.getByTestId('code-wiki-back-to-chat')).toBeInTheDocument()
  })

  it('navigates nothing on the way, so the page does not reload', async () => {
    // Clearing the task from the URL meant a router navigation, which re-rendered the
    // knowledge page around it and flashed the knowledge base list.
    await renderReader()
    fireEvent.click(screen.getByTestId('fake-send'))
    await waitFor(() =>
      expect(screen.getByTestId('code-wiki-back-to-document')).toBeInTheDocument()
    )

    fireEvent.click(screen.getByTestId('code-wiki-back-to-document'))

    await waitFor(() => expect(screen.getByTestId('wiki-page-content')).toBeInTheDocument())
    expect(replace).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })

  it('treats picking a page from the navigation as going back to reading', async () => {
    await renderReader()
    fireEvent.click(screen.getByTestId('fake-send'))
    await waitFor(() =>
      expect(screen.getByTestId('code-wiki-back-to-document')).toBeInTheDocument()
    )

    fireEvent.click(screen.getByTestId('wiki-nav-page-other'))

    await waitFor(() => expect(screen.getByTestId('wiki-page-content')).toBeInTheDocument())
    expect(screen.getByTestId('messages')).toBeInTheDocument()
  })
})

describe('arriving with a conversation already open', () => {
  it('can still be sent back to the page', async () => {
    // The empty state is never rendered on this path, so the page body never mounts
    // and never reports — the signal the reader relies on simply does not arrive.
    // Seeded from the URL instead, which is what the conversation list puts there.
    arrivesWithConversation = true
    search = 'taskId=548'
    await renderReader()

    expect(screen.getByTestId('messages')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('code-wiki-back-to-document'))

    await waitFor(() => expect(screen.getByTestId('wiki-page-content')).toBeInTheDocument())
    expect(screen.getByTestId('code-wiki-chat-pane')).toHaveClass('hidden')
  })

  it('opens the page picked from the navigation', async () => {
    arrivesWithConversation = true
    search = 'taskId=548'
    await renderReader()

    fireEvent.click(screen.getByTestId('wiki-nav-page-other'))

    await waitFor(() => expect(screen.getByTestId('wiki-page-content')).toBeInTheDocument())
  })
})
