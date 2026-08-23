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
import { codeWikiApi } from '@/apis/code-wiki'
import { getKnowledgeBaseRetrievalProfile } from '@/apis/knowledge'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/apis/code-wiki', () => ({
  codeWikiApi: { resolve: jest.fn().mockResolvedValue(null) },
}))

jest.mock('@/apis/knowledge', () => ({
  getMultimodalDefaultPrompts: jest.fn().mockResolvedValue({
    enabled: false,
    video_prompt: '',
    image_prompt: '',
  }),
  getKnowledgeBaseRetrievalProfile: jest.fn().mockResolvedValue({
    version: 1,
    retrieval_config: {
      retriever_name: 'public-retriever',
      retriever_namespace: 'default',
      embedding_config: { model_name: 'public-embedding', model_namespace: 'default' },
      retrieval_mode: 'hybrid',
      top_k: 5,
      score_threshold: 0.5,
      hybrid_weights: { vector_weight: 0.7, keyword_weight: 0.3 },
    },
    health: { status: 'valid', fallback_reason: null },
  }),
}))

// The model selector fetches on mount. Left real it resolves after the test ends,
// setting state on an unmounted tree.
jest.mock('@/apis/models', () => ({
  modelApis: { getUnifiedModels: jest.fn().mockResolvedValue({ data: [] }) },
}))

jest.mock('@/features/tasks/components/selector', () => ({
  RepositorySelector: () => <div data-testid="repository-selector" />,
}))

jest.mock('@/components/model-select/ModelRefSelector', () => ({
  ModelRefSelector: ({ error }: { error?: string }) => (
    <div data-testid="model-ref-selector">{error}</div>
  ),
}))

// The code option is behind a staged rollout. These tests are about what choosing it
// does, so they turn it on; the test below is about the rollout itself.
const mockRuntimeConfig = jest.fn(() => ({ enableCodeWiki: true }))
jest.mock('@/lib/runtime-config', () => ({
  getRuntimeConfigSync: () => mockRuntimeConfig(),
}))

const mockedGetKnowledgeBaseRetrievalProfile = getKnowledgeBaseRetrievalProfile as jest.Mock

describe('CreateKnowledgeBaseDialog kind selection', () => {
  beforeEach(() => {
    mockRuntimeConfig.mockReturnValue({ enableCodeWiki: true })
    mockedGetKnowledgeBaseRetrievalProfile.mockReset()
    mockedGetKnowledgeBaseRetrievalProfile.mockImplementation(() => new Promise(() => undefined))
  })

  it('starts on documents, where a name is required', async () => {
    const onSubmit = jest.fn()
    render(<CreateKnowledgeBaseDialog open onOpenChange={jest.fn()} onSubmit={onSubmit} />)

    fireEvent.click(screen.getByTestId('submit-create-kb'))

    await waitFor(() => expect(onSubmit).not.toHaveBeenCalled())
  })

  it('loads the retrieval profile for documents before a kind is selected', async () => {
    render(<CreateKnowledgeBaseDialog open onOpenChange={jest.fn()} onSubmit={jest.fn()} />)

    await waitFor(() => expect(getKnowledgeBaseRetrievalProfile).toHaveBeenCalledTimes(1))
  })

  it('swaps the opening-view field for repository fields when code is chosen', async () => {
    render(<CreateKnowledgeBaseDialog open onOpenChange={jest.fn()} onSubmit={jest.fn()} />)

    fireEvent.click(screen.getByTestId('create-kb-kind-code'))

    // A code wiki has no notebook/classic choice: it has a reader of its own.
    expect(screen.queryByTestId('switch-kb-type')).not.toBeInTheDocument()
    expect(screen.getByTestId('repository-selector')).toBeInTheDocument()
    expect(screen.getByTestId('code-wiki-language')).toBeInTheDocument()
  })

  it('shows when an unusable profile falls back to automatic defaults', async () => {
    mockedGetKnowledgeBaseRetrievalProfile.mockResolvedValue({
      version: 1,
      retrieval_config: null,
      health: { status: 'invalid', fallback_reason: 'retriever_unavailable' },
    })
    render(<CreateKnowledgeBaseDialog open onOpenChange={jest.fn()} onSubmit={jest.fn()} />)

    await screen.findByTestId('knowledge-retrieval-profile-fallback')
    expect(
      screen.getByText('knowledge:document.retrievalProfile.fallbackReasons.retriever_unavailable')
    ).toBeInTheDocument()
  })

  it('shows the automatic-default notice when no profile is configured', async () => {
    mockedGetKnowledgeBaseRetrievalProfile.mockResolvedValue({
      version: 0,
      retrieval_config: null,
      health: { status: 'missing', fallback_reason: null },
    })
    render(<CreateKnowledgeBaseDialog open onOpenChange={jest.fn()} onSubmit={jest.fn()} />)

    await screen.findByTestId('knowledge-retrieval-profile-fallback')
    expect(
      screen.getByText('knowledge:document.retrievalProfile.fallbackReasons.unavailable')
    ).toBeInTheDocument()
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

  it('will not create a wiki until a model has been chosen to generate it', async () => {
    // A wiki hands a whole repository to whichever model it names, so that is a
    // choice the creator makes rather than one inherited from the team's bot.
    const onSubmit = jest.fn()
    render(<CreateKnowledgeBaseDialog open onOpenChange={jest.fn()} onSubmit={onSubmit} />)

    fireEvent.click(screen.getByTestId('create-kb-kind-code'))
    fireEvent.click(screen.getByTestId('code-wiki-source-mode-url'))
    fireEvent.change(screen.getByTestId('code-wiki-source-url'), {
      target: { value: 'https://github.com/wecode-ai/Wegent.git' },
    })
    // The URL is committed to the form only once the debounced probe has run. Until
    // then the repository check below fails first and this proves nothing.
    await waitFor(() => expect(codeWikiApi.resolve).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId('submit-create-kb'))

    // Named rather than just absent: without the model error the repository check
    // above would produce the same silence, and this would pass for the wrong reason.
    await screen.findByText('knowledge:codeWiki.create.modelRequired')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('tells the creator that generating exposes the repository to the model', () => {
    render(<CreateKnowledgeBaseDialog open onOpenChange={jest.fn()} onSubmit={jest.fn()} />)

    fireEvent.click(screen.getByTestId('create-kb-kind-code'))

    expect(screen.getByText('knowledge:codeWiki.create.modelDescription')).toBeInTheDocument()
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
