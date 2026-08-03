// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Which platform hosts a repository cannot be read off a self-hosted domain, and
 * guessing wrong is not a harmless wrong guess: the request reaches a real API of
 * another vendor, which answers with a retired-version error or "invalid token" for
 * a credential that is perfectly good. Those read as network or credential faults.
 *
 * The caller has usually already said what the host is, by configuring a token for
 * it. That answer is used before any public default.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { CodeWikiSourceFields } from '@/features/knowledge/code-wiki/CodeWikiSourceFields'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
jest.mock('@/apis/code-wiki', () => ({
  codeWikiApi: { resolve: jest.fn().mockResolvedValue(null) },
}))
jest.mock('@/features/tasks/components/selector', () => ({
  RepositorySelector: () => <div data-testid="repository-selector" />,
}))

const mockUser = jest.fn()
jest.mock('@/features/common/UserContext', () => ({
  useUser: () => mockUser(),
}))

const EMPTY = {
  source_type: 'github' as const,
  source_url: '',
  language: 'zh',
  resolution: null,
}

function renderWith(gitInfo: Array<{ git_domain: string; type: string }>) {
  mockUser.mockReturnValue({ user: { git_info: gitInfo } })
  render(<CodeWikiSourceFields value={EMPTY} onChange={jest.fn()} />)
  fireEvent.click(screen.getByTestId('code-wiki-source-mode-url'))
  fireEvent.change(screen.getByTestId('code-wiki-source-url'), {
    target: { value: 'https://git.intra.example.com/team/app' },
  })
}

describe('code wiki source type inference', () => {
  it('does not ask when the caller has a credential for that host', () => {
    renderWith([{ git_domain: 'git.intra.example.com', type: 'gitlab' }])

    // The picker only appears when the host cannot be identified.
    expect(screen.queryByTestId('code-wiki-source-type')).not.toBeInTheDocument()
  })

  it('asks when the host is unknown to it', () => {
    renderWith([{ git_domain: 'somewhere.else.com', type: 'gitlab' }])

    expect(screen.getByTestId('code-wiki-source-type')).toBeInTheDocument()
  })
})
