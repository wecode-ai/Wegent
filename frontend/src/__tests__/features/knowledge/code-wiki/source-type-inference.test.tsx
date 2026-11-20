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
import { useState } from 'react'
import {
  CodeWikiSourceFields,
  useCodeWikiRepository,
  type CodeWikiSourceDraft,
} from '@/features/knowledge/code-wiki/CodeWikiSourceFields'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
jest.mock('@/apis/code-wiki', () => ({
  codeWikiApi: {
    resolve: jest.fn().mockResolvedValue(null),
    strategies: jest.fn().mockResolvedValue({ default_strategy: null, strategies: [] }),
  },
}))
jest.mock('@/features/tasks/components/selector', () => ({
  RepositorySelector: () => <div data-testid="repository-selector" />,
}))
jest.mock('@/features/knowledge/code-wiki/GenerationStrategySelect', () => ({
  GenerationStrategySelect: () => null,
}))

const mockUser = jest.fn()
jest.mock('@/features/common/UserContext', () => ({
  useUser: () => mockUser(),
}))

const EMPTY: CodeWikiSourceDraft = {
  mode: 'select',
  repo: null,
  urlInput: '',
  urlSourceType: 'github',
  language: 'zh',
  probe: null,
}

function SourceForm({ initial = EMPTY }: { initial?: CodeWikiSourceDraft }) {
  const [draft, setDraft] = useState(initial)
  const repository = useCodeWikiRepository(draft)
  return <CodeWikiSourceFields value={draft} repository={repository} onChange={setDraft} />
}

function renderWith(gitInfo: Array<{ git_domain: string; type: string }>) {
  mockUser.mockReturnValue({ user: { git_info: gitInfo } })
  render(<SourceForm />)
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

it('opens an existing wiki by ID without assuming its namespace', () => {
  mockUser.mockReturnValue({ user: { git_info: [] } })
  const url = 'https://github.com/team/repo'
  render(
    <SourceForm
      initial={{
        ...EMPTY,
        mode: 'url',
        urlInput: url,
        probe: {
          url,
          type: 'github',
          result: {
            exists: true,
            visibility: 'public',
            default_branch: 'main',
            name: 'repo',
            description: '',
            access: 'public',
            existing_wikis: [
              { id: 42, name: 'Shared wiki', owner_name: 'Owner', accessible: true },
            ],
          },
        },
      }}
    />
  )
  expect(screen.getByTestId('code-wiki-existing-open-42')).toHaveAttribute(
    'href',
    '/knowledge/document/42'
  )
})
