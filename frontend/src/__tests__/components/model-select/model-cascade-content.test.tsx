// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  ModelCascadeContent,
  type ModelCascadeLabels,
} from '@/components/model-select/ModelCascadeSelect'
import type { GroupableModel } from '@/components/model-select/model-grouping'

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

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
})
