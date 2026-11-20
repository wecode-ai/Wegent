// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * The create dialog now covers both kinds, so what is pinned here is that choosing
 * one does not leave the other's rules in force — most of all the name, which is
 * required for a document knowledge base and deliberately optional for a code wiki.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CreateKnowledgeBaseDialog } from '@/features/knowledge/document/components/CreateKnowledgeBaseDialog'
import { codeWikiApi } from '@/apis/code-wiki'
import type { SummaryModelRef } from '@/types/knowledge'
import { getKnowledgeBaseRetrievalProfile } from '@/apis/knowledge'
import { retrieverApis } from '@/apis/retrievers'
import { modelApis } from '@/apis/models'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/apis/code-wiki', () => ({
  codeWikiApi: {
    resolve: jest.fn().mockResolvedValue(null),
    strategies: jest.fn().mockResolvedValue({ default_strategy: null, strategies: [] }),
  },
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

jest.mock('@/apis/retrievers', () => ({
  retrieverApis: {
    getUnifiedRetrievers: jest.fn().mockResolvedValue({ data: [] }),
    getStorageRetrievalMethods: jest.fn().mockResolvedValue({ data: {} }),
  },
}))

jest.mock('@/features/tasks/components/selector', () => ({
  RepositorySelector: () => <div data-testid="repository-selector" />,
}))
jest.mock('@/features/knowledge/code-wiki/GenerationStrategySelect', () => ({
  GenerationStrategySelect: () => null,
}))

jest.mock('@/components/model-select/ModelRefSelector', () => ({
  ModelRefSelector: ({
    error,
    dataTestId,
    onChange,
  }: {
    error?: string
    dataTestId: string
    onChange: (value: SummaryModelRef) => void
  }) => (
    <div data-testid="model-ref-selector">
      {error}
      {dataTestId === 'code-wiki-execution-model-select' && (
        <button
          type="button"
          onClick={() => onChange({ name: 'wiki-model', type: 'public', namespace: 'default' })}
        >
          Choose Wiki model
        </button>
      )}
    </div>
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
  const originalResizeObserver = global.ResizeObserver

  beforeAll(() => {
    // JSDOM does not provide the browser observer used by Radix Slider.
    global.ResizeObserver = jest.fn().mockImplementation(() => ({
      observe: jest.fn(),
      unobserve: jest.fn(),
      disconnect: jest.fn(),
    }))
  })

  afterAll(() => {
    global.ResizeObserver = originalResizeObserver
  })

  beforeEach(() => {
    mockRuntimeConfig.mockReturnValue({ enableCodeWiki: true })
    mockedGetKnowledgeBaseRetrievalProfile.mockReset()
    mockedGetKnowledgeBaseRetrievalProfile.mockImplementation(() => new Promise(() => undefined))
  })

  it('loads only the active retrieval panel and ignores late responses from the previous space', async () => {
    let resolvePersonal!: () => void
    jest
      .mocked(retrieverApis.getUnifiedRetrievers)
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolvePersonal = () =>
              resolve({
                data: [
                  {
                    name: 'personal-index',
                    displayName: 'Personal index',
                    type: 'user',
                    namespace: 'default',
                    storageType: 'qdrant',
                  },
                ],
              })
          })
      )
      .mockResolvedValueOnce({
        data: [
          {
            name: 'team-index',
            displayName: 'Team index',
            type: 'group',
            namespace: 'team-space',
            storageType: 'qdrant',
          },
        ],
      })
    render(
      <CreateKnowledgeBaseDialog
        open
        onOpenChange={jest.fn()}
        onSubmit={jest.fn()}
        scope="personal"
        showGroupSelector
        availableGroups={[
          {
            id: 'personal',
            name: 'default',
            displayName: 'Personal',
            type: 'personal',
            canCreate: true,
          },
          { id: 'team', name: 'team-space', displayName: 'Team', type: 'group', canCreate: true },
        ]}
      />
    )
    fireEvent.click(screen.getByTestId('knowledge-advanced-section-trigger'))
    await waitFor(() =>
      expect(retrieverApis.getUnifiedRetrievers).toHaveBeenCalledWith('personal', undefined)
    )
    fireEvent.click(screen.getByTestId('rag-mode-disabled'))
    fireEvent.click(screen.getByTestId('knowledge-basic-section-trigger'))
    fireEvent.click(screen.getByTestId('group-selector'))
    fireEvent.click(await screen.findByTestId('create-space-option-team'))

    expect(retrieverApis.getUnifiedRetrievers).not.toHaveBeenCalledWith('group', 'team-space')
    expect(modelApis.getUnifiedModels).not.toHaveBeenCalledWith(
      undefined,
      false,
      'group',
      'team-space',
      'embedding'
    )
    fireEvent.click(screen.getByTestId('knowledge-advanced-section-trigger'))
    expect(screen.getByTestId('rag-mode-auto')).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() =>
      expect(retrieverApis.getUnifiedRetrievers).toHaveBeenLastCalledWith('group', 'team-space')
    )
    await waitFor(() =>
      expect(modelApis.getUnifiedModels).toHaveBeenCalledWith(
        undefined,
        false,
        'group',
        'team-space',
        'embedding'
      )
    )

    expect(await screen.findByText('Team index', { exact: false })).toBeVisible()
    await act(async () => resolvePersonal())
    expect(screen.getByText('Team index', { exact: false })).toBeVisible()
    expect(screen.queryByText('Personal index', { exact: false })).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('knowledge-basic-section-trigger'))
    fireEvent.click(screen.getByTestId('group-selector'))
    fireEvent.click(await screen.findByTestId('create-space-option-personal'))
    expect(retrieverApis.getUnifiedRetrievers).toHaveBeenLastCalledWith('group', 'team-space')
    fireEvent.click(screen.getByTestId('knowledge-advanced-section-trigger'))
    expect(screen.getByTestId('rag-mode-disabled')).toHaveAttribute('aria-pressed', 'true')
    expect(retrieverApis.getUnifiedRetrievers).toHaveBeenLastCalledWith('group', 'team-space')
    fireEvent.click(screen.getByTestId('rag-mode-auto'))
    await waitFor(() =>
      expect(retrieverApis.getUnifiedRetrievers).toHaveBeenLastCalledWith('personal', undefined)
    )
  })

  it('opens Basic Information and returns to the name when validation fails on another section', () => {
    const onSubmit = jest.fn()
    render(<CreateKnowledgeBaseDialog open onOpenChange={jest.fn()} onSubmit={onSubmit} />)

    const basic = screen.getByTestId('knowledge-basic-section-trigger')
    expect(basic.getAttribute('aria-current')).toBe('true')
    fireEvent.change(screen.getByTestId('kb-description-input'), {
      target: { value: 'Release documentation' },
    })
    fireEvent.click(screen.getByTestId('knowledge-access-section-trigger'))
    fireEvent.click(screen.getByTestId('submit-create-kb'))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(basic.getAttribute('aria-current')).toBe('true')
    expect(document.activeElement).toBe(screen.getByTestId('kb-name-input'))
    expect(screen.getByDisplayValue('Release documentation')).toBeInTheDocument()
  })

  it('loads the retrieval profile for documents before a kind is selected', async () => {
    render(<CreateKnowledgeBaseDialog open onOpenChange={jest.fn()} onSubmit={jest.fn()} />)

    await waitFor(() => expect(getKnowledgeBaseRetrievalProfile).toHaveBeenCalledTimes(1))
  })

  it('silently falls back to automatic defaults when no profile is usable', async () => {
    let resolveProfile: (value: {
      version: number
      retrieval_config: null
      health: { status: string; fallback_reason: string }
    }) => void
    mockedGetKnowledgeBaseRetrievalProfile.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveProfile = resolve
        })
    )
    render(<CreateKnowledgeBaseDialog open onOpenChange={jest.fn()} onSubmit={jest.fn()} />)

    await waitFor(() => expect(mockedGetKnowledgeBaseRetrievalProfile).toHaveBeenCalledTimes(1))
    await act(async () => {
      resolveProfile({
        version: 1,
        retrieval_config: null,
        health: { status: 'invalid', fallback_reason: 'retriever_unavailable' },
      })
      await Promise.resolve()
    })

    expect(screen.queryByTestId('knowledge-retrieval-profile-fallback')).not.toBeInTheDocument()
  })

  it('swaps the opening-view field for repository fields when code is chosen', async () => {
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

  it('will not create a wiki until a model has been chosen to generate it', async () => {
    // A wiki hands a whole repository to whichever model it names, so that is a
    // choice the creator makes rather than one inherited from the team's bot.
    const onSubmit = jest.fn()
    let finishResolve!: () => void
    jest.mocked(codeWikiApi.resolve).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishResolve = () =>
            resolve({
              exists: true,
              visibility: 'public',
              default_branch: 'main',
              name: 'wecode-ai/Wegent',
              description: '',
              access: 'public',
              existing_wikis: [],
            })
        })
    )
    render(<CreateKnowledgeBaseDialog open onOpenChange={jest.fn()} onSubmit={onSubmit} />)

    fireEvent.click(screen.getByTestId('create-kb-kind-code'))
    fireEvent.click(screen.getByTestId('code-wiki-source-mode-url'))
    fireEvent.change(screen.getByTestId('code-wiki-source-url'), {
      target: { value: 'https://github.com/wecode-ai/Wegent.git' },
    })
    fireEvent.click(screen.getByTestId('knowledge-generation-section-trigger'))
    // Let the repository lookup run while a different section is visible.
    await waitFor(() => expect(codeWikiApi.resolve).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('code-wiki-show-generation-task'))
    await act(async () => finishResolve())
    expect(screen.getByTestId('code-wiki-show-generation-task')).toBeChecked()

    fireEvent.click(screen.getByTestId('submit-create-kb'))

    // Named rather than just absent: without the model error the repository check
    // above would produce the same silence, and this would pass for the wrong reason.
    await screen.findByText('knowledge:codeWiki.create.modelRequired')
    expect(screen.getByTestId('kb-name-input').closest('section')?.hidden).toBe(false)
    expect(screen.getByDisplayValue('https://github.com/wecode-ai/Wegent.git')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submits the current repository while an earlier probe is returning', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined)
    const olderUrl = 'https://github.com/wecode-ai/old-repo'
    const currentUrl = 'https://github.com/wecode-ai/current-repo'
    let resolveOlder!: () => void
    jest.useFakeTimers()
    try {
      jest.mocked(codeWikiApi.resolve).mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveOlder = () =>
              resolve({
                exists: true,
                visibility: 'public',
                default_branch: 'main',
                name: 'Old repository',
                description: '',
                access: 'public',
                existing_wikis: [],
              })
          })
      )
      render(<CreateKnowledgeBaseDialog open onOpenChange={jest.fn()} onSubmit={onSubmit} />)
      fireEvent.click(screen.getByTestId('create-kb-kind-code'))
      fireEvent.click(screen.getByRole('button', { name: 'Choose Wiki model' }))
      fireEvent.click(screen.getByTestId('code-wiki-source-mode-url'))
      const repository = screen.getByTestId('code-wiki-source-url')
      fireEvent.change(repository, { target: { value: olderUrl } })
      act(() => jest.advanceTimersByTime(600))
      fireEvent.change(repository, { target: { value: currentUrl } })
      await act(async () => resolveOlder())
      fireEvent.click(screen.getByTestId('knowledge-summary-section-trigger'))
      fireEvent.click(screen.getByRole('switch'))
      fireEvent.click(screen.getByTestId('submit-create-kb'))
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          source_url: currentUrl,
          resolved_name: undefined,
        })
      )
    } finally {
      jest.useRealTimers()
    }
  })

  it('shows and submits the same repository after switching knowledge base kinds', () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined)
    const url = 'https://github.com/wecode-ai/wegent'
    render(<CreateKnowledgeBaseDialog open onOpenChange={jest.fn()} onSubmit={onSubmit} />)

    fireEvent.click(screen.getByTestId('create-kb-kind-code'))
    fireEvent.click(screen.getByRole('button', { name: 'Choose Wiki model' }))
    fireEvent.click(screen.getByTestId('code-wiki-source-mode-url'))
    fireEvent.change(screen.getByTestId('code-wiki-source-url'), { target: { value: url } })
    fireEvent.click(screen.getByTestId('create-kb-kind-document'))
    fireEvent.click(screen.getByTestId('create-kb-kind-code'))

    expect(screen.getByTestId('code-wiki-source-mode-url')).toBeChecked()
    expect(screen.getByTestId('code-wiki-source-url')).toHaveValue(url)
    fireEvent.click(screen.getByTestId('knowledge-summary-section-trigger'))
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.click(screen.getByTestId('submit-create-kb'))
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ source_url: url }))
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
