// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from '@testing-library/react'
import { WikiNavigation } from '@/features/knowledge/code-wiki/WikiNavigation'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const pages = [
  {
    path: 'architecture',
    title: 'Architecture',
    document_id: 1,
    has_content: true,
    children: [
      {
        path: 'architecture/backend',
        title: 'Backend',
        document_id: 2,
        has_content: true,
        children: [
          {
            path: 'architecture/backend/api',
            title: 'API',
            document_id: 3,
            has_content: true,
            children: [],
          },
        ],
      },
    ],
  },
]

describe('wiki navigation expansion', () => {
  it('opens the first directory level by default without reopening a manual collapse', () => {
    const { rerender } = render(<WikiNavigation pages={pages} activePath="" onSelect={jest.fn()} />)

    const architecture = screen.getByTestId('wiki-nav-toggle-architecture')
    expect(architecture).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('wiki-nav-page-architecture/backend')).toBeInTheDocument()
    expect(screen.queryByTestId('wiki-nav-page-architecture/backend/api')).not.toBeInTheDocument()

    fireEvent.click(architecture)

    expect(architecture).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('wiki-nav-page-architecture/backend')).not.toBeInTheDocument()

    rerender(<WikiNavigation pages={[...pages]} activePath="" onSelect={jest.fn()} />)

    expect(architecture).toHaveAttribute('aria-expanded', 'false')
  })

  it('still opens deeper ancestors for the active page', () => {
    render(
      <WikiNavigation pages={pages} activePath="architecture/backend/api" onSelect={jest.fn()} />
    )

    expect(screen.getByTestId('wiki-nav-toggle-architecture/backend')).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByTestId('wiki-nav-page-architecture/backend/api')).toBeInTheDocument()
  })
})
