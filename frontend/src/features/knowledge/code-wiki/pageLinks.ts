// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Turning a link written inside a wiki page into the page it means.
 *
 * Page paths are the wiki's identities — `index`, `architecture/backend` — and the
 * agent is told to link between pages by path. What it actually writes varies: an
 * agent that has spent the run reading a repository writes repository-shaped links,
 * so `./architecture/backend.md` and `../index` turn up alongside the plain form.
 *
 * Resolving them here rather than rejecting them is deliberate. The alternative is a
 * page whose links all miss, and a reader who cannot tell a broken link from a
 * strictly-formatted one.
 */

const EXTERNAL = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const MARKDOWN_EXTENSION = /\.(md|markdown)$/i

/** Where a link points, once it is known to be internal. */
export interface PageLink {
  /** The page it resolves to, or `null` when the wiki has no such page. */
  path: string | null
}

/**
 * The page a link refers to, or `null` when it refers to none.
 *
 * Returns `null` for anything the reader should not handle — an absolute URL, a
 * `mailto:`, a bare `#anchor` — so the caller can leave those to the browser.
 */
export function resolvePageLink(
  href: string,
  knownPaths: ReadonlySet<string>,
  currentPath: string
): string | null {
  if (!href || EXTERNAL.test(href) || href.startsWith('#')) return null

  // A fragment or query on an internal link addresses a position within the target
  // page, not a different page.
  const withoutFragment = href.split('#')[0].split('?')[0]
  if (!withoutFragment) return null

  const cleaned = withoutFragment.replace(MARKDOWN_EXTENSION, '')
  const absolute = cleaned.startsWith('/') ? cleaned.slice(1) : joinRelative(currentPath, cleaned)

  // Paths are lowercase by contract, and two may not differ only by case, so folding
  // here cannot merge two real pages into one.
  const candidate = absolute.toLowerCase().replace(/^\/+|\/+$/g, '')
  if (!candidate) return null

  return knownPaths.has(candidate) ? candidate : null
}

/** Apply a relative link to the directory the current page sits in. */
function joinRelative(currentPath: string, href: string): string {
  // A link with no `./` or `../` is read as a full path first: that is the form the
  // agent is asked for, and it is unambiguous. Only when the wiki has no such page is
  // it worth reading as a sibling, which `resolvePageLink` does not do — a link that
  // means two things is worse than one that visibly misses.
  if (!href.startsWith('./') && !href.startsWith('../')) return href

  const segments = currentPath.split('/').slice(0, -1)
  for (const part of href.split('/')) {
    if (part === '.' || part === '') continue
    if (part === '..') segments.pop()
    else segments.push(part)
  }
  return segments.join('/')
}
