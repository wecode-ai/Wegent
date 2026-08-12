// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * On a narrow screen the reader had no way between pages.
 *
 * The page tree is a column hidden below `lg`, so a phone or a narrow window opened
 * the wiki on whichever page came first and stayed there — every other page was
 * unreachable, including through the cross-page links, which only help once you are
 * on a page that has them.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CodeWikiReader } from '@/features/knowledge/code-wiki/CodeWikiReader'
import type { KnowledgeBase } from '@/types/knowledge'

const mockPush = jest.fn()

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: mockPush }),
  usePathname: () => '/knowledge/default/wecode-ai%2FWegent',
  useSearchParams: () => new URLSearchParams(''),
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

jest.mock('@/features/tasks/components/chat', () => ({
  ChatArea: ({ emptyStateContent }: { emptyStateContent?: React.ReactNode }) => (
    <div>{emptyStateContent}</div>
  ),
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

beforeAll(() => {
  // The drawer primitive asks the platform about reduced motion; jsdom has no
  // matchMedia, and without it the drawer throws the moment it opens.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    }),
  })
})

async function renderReader() {
  render(<CodeWikiReader wiki={WIKI} />)
  await waitFor(() => expect(screen.getByTestId('code-wiki-reader')).toBeInTheDocument())
}

describe('navigating a wiki on a narrow screen', () => {
  beforeEach(() => {
    mockPush.mockReset()
  })

  it('offers a way into the page tree', async () => {
    await renderReader()

    const trigger = screen.getByTestId('code-wiki-open-navigation')
    // The guidelines put the floor at 44px for a control that is only reachable on
    // a touch screen, and this is the only route between pages there.
    expect(trigger).toHaveClass('h-11', 'w-11')
    // Hidden where the column is shown, so the two never both appear.
    expect(trigger).toHaveClass('lg:hidden')
  })

  it('opens the tree, and picking a page there opens that page', async () => {
    await renderReader()
    // The reader lands on the first page with content. Scoped to the page header,
    // because the title also appears in the tree beside it.
    const header = () => screen.getByTestId('wiki-page-content').parentElement?.textContent ?? ''
    expect(header()).toContain('Overview')

    fireEvent.click(screen.getByTestId('code-wiki-open-navigation'))

    // Two trees exist once it opens: the column and the drawer's copy.
    await waitFor(() =>
      expect(screen.getAllByTestId('wiki-nav-page-other').length).toBeGreaterThan(1)
    )

    // The drawer's copy, not the column's.
    fireEvent.click(screen.getAllByTestId('wiki-nav-page-other')[1])

    // Asserted on the page that opened rather than on the drawer disappearing: the
    // drawer stays mounted through its close animation, and what matters is that the
    // choice took effect.
    await waitFor(() => expect(header()).toContain('Other'))
  })

  it('carries the run history too, which is the rest of the column it replaces', async () => {
    // With only the tree here, the history was reachable on a narrow screen exactly
    // when the wiki had no pages -- so on a wiki that had been generated, whether the
    // last run failed and which version is live could not be seen, and a version
    // could not be restored.
    await renderReader()

    fireEvent.click(screen.getByTestId('code-wiki-open-navigation'))

    // Scoped to the drawer. The column's own copy is in the document either way --
    // jsdom does not apply the `hidden` that removes it from a narrow screen -- so
    // counting instances would pass whether or not the drawer carries one.
    const drawer = await screen.findByTestId('code-wiki-navigation-drawer')
    expect(within(drawer).getByTestId('run-history')).toBeInTheDocument()
  })

  it('sizes the tree for a finger where the tree is a drawer', async () => {
    await renderReader()

    fireEvent.click(screen.getByTestId('code-wiki-open-navigation'))

    await waitFor(() =>
      expect(screen.getAllByTestId('wiki-nav-page-other').length).toBeGreaterThan(1)
    )
    // The row a finger lands on. Reset above `lg`, where the same tree is a dense
    // sidebar column and a tall row costs visible pages.
    const row = screen.getAllByTestId('wiki-nav-page-other')[1]
    expect(row).toHaveClass('min-h-11', 'lg:min-h-0')
  })

  it('shows the configuration control only when the page grants manage permission', async () => {
    const onConfigure = jest.fn()

    render(<CodeWikiReader wiki={WIKI} canConfigure onConfigure={onConfigure} />)

    const configure = await screen.findByTestId('code-wiki-configure')
    expect(configure).toHaveClass('h-11', 'w-11')
    fireEvent.click(configure)
    expect(onConfigure).toHaveBeenCalledTimes(1)
  })

  it('does not show the configuration control without manage permission', async () => {
    await renderReader()

    expect(screen.queryByTestId('code-wiki-configure')).not.toBeInTheDocument()
  })

  it('returns to the unified knowledge-base list', async () => {
    await renderReader()

    fireEvent.click(screen.getByTestId('code-wiki-back-to-list'))

    expect(mockPush).toHaveBeenCalledWith('/knowledge?type=document')
  })

  it('offers nothing to open when the wiki has no pages', async () => {
    const { codeWikiApi } = jest.requireMock('@/apis/code-wiki')
    codeWikiApi.pages.mockResolvedValueOnce({ pages: [] })

    await renderReader()

    expect(screen.queryByTestId('code-wiki-open-navigation')).not.toBeInTheDocument()
  })
})
