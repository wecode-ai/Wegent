// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * The icon rule had been written out at four sites, each as "classic or not", so a
 * third kind of knowledge base rendered as a notebook everywhere except the one that
 * got fixed. What is pinned here is that each kind is distinguishable — the point of
 * the icon — and that an unknown kind still renders something.
 */

import { render } from '@testing-library/react'
import { KnowledgeBaseIcon } from '@/features/knowledge/document/components/KnowledgeBaseIcon'

function iconNameOf(kbType: 'notebook' | 'classic' | 'code_wiki' | undefined) {
  const { container } = render(<KnowledgeBaseIcon kbType={kbType} />)
  return container.querySelector('svg')?.getAttribute('class') ?? ''
}

describe('KnowledgeBaseIcon', () => {
  it('gives each kind its own icon', () => {
    const notebook = iconNameOf('notebook')
    const classic = iconNameOf('classic')
    const codeWiki = iconNameOf('code_wiki')

    expect(new Set([notebook, classic, codeWiki]).size).toBe(3)
  })

  it('falls back to the notebook icon for an unknown kind', () => {
    expect(iconNameOf(undefined)).toBe(iconNameOf('notebook'))
  })

  it('passes the caller its own size', () => {
    const { container } = render(<KnowledgeBaseIcon kbType="code_wiki" className="w-4 h-4" />)

    expect(container.querySelector('svg')?.getAttribute('class')).toContain('w-4 h-4')
  })
})
