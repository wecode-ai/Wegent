// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * The create dialog now covers both kinds, so what is pinned here is that choosing
 * one does not leave the other's rules in force — most of all the name, which is
 * required for a document knowledge base and deliberately optional for a code wiki.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CreateKnowledgeBaseDialog } from '@/features/knowledge/document/components/CreateKnowledgeBaseDialog'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/apis/code-wiki', () => ({
  codeWikiApi: { resolve: jest.fn().mockResolvedValue(null) },
}))

jest.mock('@/features/tasks/components/selector', () => ({
  RepositorySelector: () => <div data-testid="repository-selector" />,
}))

// The code option is behind a staged rollout. These tests are about what choosing it
// does, so they turn it on; the test below is about the rollout itself.
const mockRuntimeConfig = jest.fn(() => ({ enableCodeWiki: true }))
jest.mock('@/lib/runtime-config', () => ({
  getRuntimeConfigSync: () => mockRuntimeConfig(),
}))

describe('CreateKnowledgeBaseDialog kind selection', () => {
  beforeEach(() => mockRuntimeConfig.mockReturnValue({ enableCodeWiki: true }))

  it('starts on documents, where a name is required', async () => {
    const onSubmit = jest.fn()
    render(<CreateKnowledgeBaseDialog open onOpenChange={jest.fn()} onSubmit={onSubmit} />)

    fireEvent.click(screen.getByTestId('submit-create-kb'))

    await waitFor(() => expect(onSubmit).not.toHaveBeenCalled())
  })

  it('swaps the opening-view field for repository fields when code is chosen', () => {
    render(<CreateKnowledgeBaseDialog open onOpenChange={jest.fn()} onSubmit={jest.fn()} />)

    fireEvent.click(screen.getByTestId('create-kb-kind-code'))

    // A code wiki has no notebook/classic choice: it has a reader of its own.
    expect(screen.queryByTestId('switch-kb-type')).not.toBeInTheDocument()
    expect(screen.getByTestId('repository-selector')).toBeInTheDocument()
    expect(screen.getByTestId('code-wiki-language')).toBeInTheDocument()
  })

  it('offers both ways to name a repository', () => {
    render(<CreateKnowledgeBaseDialog open onOpenChange={jest.fn()} onSubmit={jest.fn()} />)

    fireEvent.click(screen.getByTestId('create-kb-kind-code'))

    // The selector alone is not enough: its list is membership-scoped, so a public
    // repository the caller can read in a browser never appears in it.
    expect(screen.getByTestId('code-wiki-source-mode-select')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('code-wiki-source-mode-url'))
    expect(screen.getByTestId('code-wiki-source-url')).toBeInTheDocument()
  })
})

describe('code wiki rollout gate', () => {
  it('offers no code option at all while the rollout is off', () => {
    // Hidden rather than disabled: an option nobody in this deployment can pick is
    // noise, and the server refuses the call regardless of what the dialog shows.
    mockRuntimeConfig.mockReturnValue({ enableCodeWiki: false })

    render(<CreateKnowledgeBaseDialog open onOpenChange={jest.fn()} onSubmit={jest.fn()} />)

    expect(screen.queryByTestId('create-kb-kind-code')).not.toBeInTheDocument()
    expect(screen.getByTestId('create-kb-kind-document')).toBeInTheDocument()
  })
})
