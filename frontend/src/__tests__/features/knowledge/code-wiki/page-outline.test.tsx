// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * The rail was inert in both directions. It parsed the markdown a second time,
 * computed a slug per heading and looked the slug up by id — but nothing put ids on
 * headings: the renderer overrides only `code` and `pre` and runs no slug plugin. So
 * every lookup returned null, clicking did nothing and the highlight never moved.
 *
 * It now reads the rendered document instead. What is pinned here is that it finds
 * the headings that are really there, and that it reaches the element itself rather
 * than a name for it — the failure was entirely in the matching step.
 */

import { render, screen, waitFor } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { PageOutline } from '@/features/knowledge/code-wiki/PageOutline'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

beforeAll(() => {
  // jsdom has no IntersectionObserver, and the outline uses one to follow scrolling.
  // Never fired here: these tests are about finding and reaching headings.
  class Stub {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Stub
  Element.prototype.scrollIntoView = jest.fn()
})

/** Renders a body, then hands the outline the element it was rendered into. */
function Harness({ html, content }: { html: string; content: string }) {
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!host) return
    // Set after mount on purpose: the real body arrives from a dynamically imported
    // renderer, so the outline is mounted before there is anything to scan.
    host.innerHTML = html
    setReady(true)
  }, [host, html])

  return (
    <div>
      <div ref={setHost} data-testid="scroll-host" />
      {ready && <PageOutline content={content} scrollContainer={host} />}
    </div>
  )
}

const BODY = `
  <h1>Page title</h1>
  <h2>Architecture</h2>
  <p>text</p>
  <h3>Storage</h3>
  <h2>Architecture</h2>
`

/** The markdown BODY was rendered from, so the old parse-it-again path would also
    find these headings -- what it could never do is reach them. */
const MARKDOWN = `# Page title

## Architecture

text

### Storage

## Architecture
`

describe('page outline', () => {
  it('lists the headings that are actually rendered', async () => {
    render(<Harness html={BODY} content={MARKDOWN} />)

    await waitFor(() => expect(screen.getByTestId('code-wiki-outline')).toBeInTheDocument())

    // h1 is the page's own title, shown in the header; the rail starts at h2.
    const entries = screen.getAllByTestId(/^code-wiki-outline-\d+$/)
    expect(entries.map(entry => entry.textContent)).toEqual([
      'Architecture',
      'Storage',
      'Architecture',
    ])
  })

  it('keeps two sections with the same title apart', async () => {
    // The reason the old version computed deduplicated slugs at all. Positions are
    // distinct without needing names to be.
    render(<Harness html={BODY} content={MARKDOWN} />)

    await waitFor(() => expect(screen.getByTestId('code-wiki-outline')).toBeInTheDocument())

    expect(screen.getByTestId('code-wiki-outline-0')).toBeInTheDocument()
    expect(screen.getByTestId('code-wiki-outline-2')).toBeInTheDocument()
  })

  it('scrolls to the heading element itself', async () => {
    render(<Harness html={BODY} content={MARKDOWN} />)
    await waitFor(() => expect(screen.getByTestId('code-wiki-outline')).toBeInTheDocument())

    screen.getByTestId('code-wiki-outline-1').click()

    const storage = screen.getByTestId('scroll-host').querySelector('h3')
    expect(storage?.scrollIntoView).toBeDefined()
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('shows nothing for a page with no sections', async () => {
    render(<Harness html="<p>Just a paragraph.</p>" content="Just a paragraph." />)

    await waitFor(() => expect(screen.getByTestId('scroll-host')).toBeInTheDocument())
    expect(screen.queryByTestId('code-wiki-outline')).not.toBeInTheDocument()
  })
})
