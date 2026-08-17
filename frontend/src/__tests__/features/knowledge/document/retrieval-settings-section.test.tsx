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
  DualWeightSlider: () => <div />,
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
    methods: { milvus: ['vector'] },
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
})
