// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  GroupedModelSelect,
  ModelCascadeContent,
  type ModelCascadeLabels,
} from '@/components/model-select/ModelCascadeSelect'
import type { GroupableModel } from '@/components/model-select/model-grouping'

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

const labels: ModelCascadeLabels = {
  ungrouped: 'Ungrouped',
  uncategorized: 'Uncategorized',
  searchPlaceholder: 'Search models or groups...',
  searchResults: 'Search Results',
  noModels: 'No models available',
  noMatch: 'No matching models',
  primaryGroups: 'Primary Groups',
  secondaryGroups: 'Secondary Groups',
}

const models: GroupableModel[] = [
  {
    name: 'model-a',
    displayName: 'Model A',
    provider: 'provider-one',
    modelId: 'provider-one-model-a',
    modelGroup: 'Primary One',
    modelSubGroup: 'Secondary One',
  },
  {
    name: 'model-b',
    displayName: 'Model B',
    provider: 'provider-two',
    modelId: 'provider-two-model-b',
    modelGroup: 'Primary One',
    modelSubGroup: 'Secondary Two',
  },
  {
    name: 'model-c',
    displayName: 'Model C',
    provider: 'provider-three',
    modelId: 'provider-three-model-c',
    modelGroup: 'Primary Two',
    modelSubGroup: 'Secondary Three',
  },
]

describe('ModelCascadeContent', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('shows primary and secondary groups before choosing a model', () => {
    render(
      <ModelCascadeContent
        models={models}
        labels={labels}
        searchValue=""
        onSearchValueChange={jest.fn()}
        onSelectModel={jest.fn()}
      />
    )

    expect(screen.getByText('Primary One')).toBeInTheDocument()
    expect(screen.getByText('Primary Two')).toBeInTheDocument()
    expect(screen.getByText('Secondary One')).toBeInTheDocument()
    expect(screen.getByText('Secondary Two')).toBeInTheDocument()
    expect(screen.getByText('Model A')).toBeInTheDocument()
  })

  it('switches to flat searchable results including group text', () => {
    const onSearchValueChange = jest.fn()

    const { rerender } = render(
      <ModelCascadeContent
        models={models}
        labels={labels}
        searchValue=""
        onSearchValueChange={onSearchValueChange}
        onSelectModel={jest.fn()}
      />
    )

    fireEvent.change(screen.getByTestId('model-cascade-search-input'), {
      target: { value: 'Secondary Three' },
    })
    expect(onSearchValueChange).toHaveBeenCalledWith('Secondary Three')

    rerender(
      <ModelCascadeContent
        models={models}
        labels={labels}
        searchValue="Secondary Three"
        onSearchValueChange={onSearchValueChange}
        onSelectModel={jest.fn()}
      />
    )

    expect(screen.getByText('Search Results')).toBeInTheDocument()
    expect(screen.getByText('Model C')).toBeInTheDocument()
    expect(screen.queryByText('Model A')).not.toBeInTheDocument()
  })

  it('constrains the cascade columns so long model lists do not push the footer out', () => {
    render(
      <ModelCascadeContent
        models={models}
        labels={labels}
        searchValue=""
        onSearchValueChange={jest.fn()}
        onSelectModel={jest.fn()}
        footer={<div data-testid="model-cascade-footer-content">Footer</div>}
      />
    )

    const grid = screen.getByTestId('model-cascade-grid')
    const footer = screen.getByTestId('model-cascade-footer')

    expect(grid).toHaveClass('min-h-0')
    expect(grid.className).toContain('h-[clamp(')
    expect(footer).toHaveClass('shrink-0')
  })

  it('constrains search results so they do not push the footer out', () => {
    render(
      <ModelCascadeContent
        models={models}
        labels={labels}
        searchValue="Model"
        onSearchValueChange={jest.fn()}
        onSelectModel={jest.fn()}
        footer={<div data-testid="model-cascade-footer-content">Footer</div>}
      />
    )

    const results = screen.getByTestId('model-cascade-search-results')
    const footer = screen.getByTestId('model-cascade-footer')

    expect(results).toHaveClass('min-h-0')
    expect(results.className).toContain('h-[clamp(')
    expect(footer).toHaveClass('shrink-0')
  })

  it('shows declared image and video capabilities in model rows', () => {
    const capableModel: GroupableModel = {
      ...models[0],
      modelCapabilities: { supportsImage: true, supportsVideo: true },
    }

    render(
      <ModelCascadeContent
        models={[capableModel]}
        labels={labels}
        searchValue=""
        onSearchValueChange={jest.fn()}
        onSelectModel={jest.fn()}
      />
    )

    expect(screen.getByTitle('图片理解')).toBeInTheDocument()
    expect(screen.getByTitle('视频理解')).toBeInTheDocument()
  })

  it('falls back to model capabilities from config', () => {
    const legacyModel = {
      ...models[0],
      config: {
        modelCapabilities: { supportsImage: true, supportsVideo: true },
      },
    } as unknown as GroupableModel

    render(
      <ModelCascadeContent
        models={[legacyModel]}
        labels={labels}
        searchValue=""
        onSearchValueChange={jest.fn()}
        onSelectModel={jest.fn()}
      />
    )

    expect(screen.getByTitle('图片理解')).toBeInTheDocument()
    expect(screen.getByTitle('视频理解')).toBeInTheDocument()
  })

  it('shows declared capabilities in the selected-model trigger', () => {
    const capableModel: GroupableModel = {
      ...models[0],
      modelCapabilities: { supportsImage: true, supportsVideo: true },
    }

    render(
      <GroupedModelSelect
        models={[capableModel]}
        selectedModel={capableModel}
        labels={labels}
        onSelectModel={jest.fn()}
        placeholder="Select model"
      />
    )

    expect(screen.getByTestId('grouped-model-select')).toHaveTextContent('Model A')
    expect(screen.getByTitle('图片理解')).toBeInTheDocument()
    expect(screen.getByTitle('视频理解')).toBeInTheDocument()
  })

  it('scrolls the selected model into view when the active subgroup contains many models', async () => {
    const scrollIntoView = jest.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })

    const longModelList = Array.from({ length: 32 }, (_, index) => ({
      name: `model-${String(index).padStart(2, '0')}`,
      displayName: `Model ${String(index).padStart(2, '0')}`,
      provider: 'provider-one',
      modelId: `provider-one-model-${index}`,
      modelGroup: 'Primary One',
      modelSubGroup: 'Secondary One',
    }))
    const selectedModel = longModelList[31]

    render(
      <ModelCascadeContent
        models={longModelList}
        selectedModel={selectedModel}
        labels={labels}
        searchValue=""
        onSearchValueChange={jest.fn()}
        onSelectModel={jest.fn()}
      />
    )

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    })
  })

  it('lets mobile users navigate groups before selecting a model', () => {
    const onSelectModel = jest.fn()

    render(
      <ModelCascadeContent
        models={models}
        labels={labels}
        searchValue=""
        onSearchValueChange={jest.fn()}
        onSelectModel={onSelectModel}
        variant="mobile"
      />
    )

    expect(screen.getByTestId('model-mobile-primary-groups')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('model-mobile-primary-group-Primary-One'))
    expect(screen.getByTestId('model-mobile-secondary-groups')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('model-mobile-secondary-group-Secondary-One'))
    expect(screen.getByTestId('model-mobile-models')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('model-mobile-option-model-a'))
    expect(onSelectModel).toHaveBeenCalledWith(models[0])
  })

  it('shows declared capabilities in mobile model rows', () => {
    const capableModel: GroupableModel = {
      ...models[0],
      modelCapabilities: { supportsImage: true, supportsVideo: true },
    }

    render(
      <ModelCascadeContent
        models={[capableModel]}
        selectedModel={capableModel}
        labels={labels}
        searchValue=""
        onSearchValueChange={jest.fn()}
        onSelectModel={jest.fn()}
        variant="mobile"
      />
    )

    fireEvent.click(screen.getByTestId('model-mobile-primary-group-Primary-One'))
    fireEvent.click(screen.getByTestId('model-mobile-secondary-group-Secondary-One'))

    expect(screen.getByTitle('图片理解')).toBeInTheDocument()
    expect(screen.getByTitle('视频理解')).toBeInTheDocument()
    expect(
      screen.getByTestId('model-mobile-option-model-a').querySelector('.lucide-check')
    ).toBeInTheDocument()
  })
})
