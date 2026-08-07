// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Links between wiki pages used to do nothing useful: the renderer was handed no
 * link component, so a relative href was followed by the browser against whatever
 * route the reader happened to be on — navigating out of the wiki entirely.
 *
 * What is pinned here is which hrefs resolve to a page and which must visibly not,
 * because "goes nowhere" and "goes somewhere wrong" look identical to a reader and
 * only one of them is acceptable.
 */

import { resolvePageLink } from '@/features/knowledge/code-wiki/pageLinks'

const PAGES = new Set(['index', 'architecture', 'architecture/backend', 'modules/indexing'])

describe('resolving a link inside a wiki page', () => {
  it('takes a full path, which is the form the agent is asked for', () => {
    expect(resolvePageLink('architecture/backend', PAGES, 'index')).toBe('architecture/backend')
  })

  it('accepts the file-shaped links an agent writes after reading a repository', () => {
    // It has spent the whole run looking at files, so these turn up whatever the
    // prompt asks for.
    expect(resolvePageLink('architecture/backend.md', PAGES, 'index')).toBe('architecture/backend')
    expect(resolvePageLink('/architecture/backend', PAGES, 'index')).toBe('architecture/backend')
  })

  it('resolves a relative link against the page it was written on', () => {
    expect(resolvePageLink('./backend', PAGES, 'architecture/overview')).toBe(
      'architecture/backend'
    )
    expect(resolvePageLink('../index', PAGES, 'architecture/backend')).toBe('index')
  })

  it('keeps a fragment from turning a page link into a miss', () => {
    expect(resolvePageLink('architecture/backend#storage', PAGES, 'index')).toBe(
      'architecture/backend'
    )
  })

  it('refuses a path no page has', () => {
    // The agent linking to a page it planned and never wrote. Returning null is what
    // makes the reader render it as dead instead of navigating somewhere.
    expect(resolvePageLink('architecture/frontend', PAGES, 'index')).toBeNull()
  })

  it('leaves anything the browser should handle alone', () => {
    expect(resolvePageLink('https://example.com/x', PAGES, 'index')).toBeNull()
    expect(resolvePageLink('mailto:a@b.c', PAGES, 'index')).toBeNull()
    expect(resolvePageLink('#a-section-of-this-page', PAGES, 'index')).toBeNull()
    expect(resolvePageLink('', PAGES, 'index')).toBeNull()
  })

  it('does not read a bare name as a sibling of the current page', () => {
    // `modules/indexing` exists, but from `architecture/backend` the href `indexing`
    // is a full path and there is no such page. Guessing would make one href mean two
    // things depending on where it was written.
    expect(resolvePageLink('indexing', PAGES, 'architecture/backend')).toBeNull()
  })
})
