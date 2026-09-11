// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import { RetrievalSettingsSection } from '@/features/knowledge/document/components/RetrievalSettingsSection'

jest.mock('@/components/ui/searchable-select', () => ({
  SearchableSelect: ({
    disabled,
    items,
  }: {
    disabled?: boolean
    items: Array<{ label: string }>
  }) => (
    <button type="button" role="combobox" disabled={disabled}>
      {items.map(item => item.label).join(',')}
    </button>
  ),
}))

jest.mock('@/components/ui/radio-group', () => ({
  RadioGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  RadioGroupItem: () => <input type="radio" />,
}))

jest.mock('@/components/ui/slider', () => ({
  Slider: () => <div />,
  DualWeightSlider: ({ disabled }: { disabled?: boolean }) => (
    <div data-testid="dual-weight-slider" data-disabled={disabled ? 'true' : 'false'} />
  ),
}))

jest.mock('@/features/knowledge/document/hooks/useRetrievers', () => ({
  useRetrievers: () => ({
    retrievers: [
      {
        name: 'personal-retriever',
        namespace: 'default',
        type: 'user',
        displayName: 'Personal Retriever',
        storageType: 'milvus',
      },
      {
        name: 'milvus',
        namespace: 'default',
        type: 'public',
        displayName: 'milvus',
        storageType: 'milvus',
      },
    ],
    loading: false,
  }),
}))

jest.mock('@/features/knowledge/document/hooks/useEmbeddingModels', () => ({
  useEmbeddingModels: () => ({
    models: [],
    loading: false,
  }),
}))

jest.mock('@/features/knowledge/document/hooks/useRetrievalMethods', () => ({
  useRetrievalMethods: () => ({
    methods: { milvus: ['vector', 'hybrid'] },
    loading: false,
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

describe('RetrievalSettingsSection', () => {
  test('keeps retriever selection enabled when embedding models are unavailable', () => {
    render(
      <RetrievalSettingsSection
        config={{
          retriever_name: 'personal-retriever',
          retriever_namespace: 'default',
        }}
        onChange={jest.fn()}
      />
    )

    const selectors = screen.getAllByRole('combobox')
    expect(selectors[0]).toBeEnabled()
    expect(selectors[1]).toBeDisabled()
  })

  test('disables hybrid weights with a rank-fusion hint for milvus retrievers', () => {
    render(
      <RetrievalSettingsSection
        config={{
          retriever_name: 'personal-retriever',
          retriever_namespace: 'default',
          retrieval_mode: 'hybrid',
        }}
        onChange={jest.fn()}
      />
    )

    expect(screen.getByTestId('dual-weight-slider')).toHaveAttribute('data-disabled', 'true')
    expect(screen.getByText('document.retrieval.milvusHybridRankFusion')).toBeInTheDocument()
  })
})
