// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import ModelSelector from '@/features/tasks/components/selector/ModelSelector'
import type { Model } from '@/features/tasks/hooks/useModelSelection'

// Mock ResizeObserver for Radix and cmdk components
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Element.prototype.scrollIntoView = jest.fn()

const mockSelectModelByKey = jest.fn()
const mockSelectDefaultModel = jest.fn()
const mockRefreshModels = jest.fn()
const mockSetShowAdvancedModels = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

jest.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
}))

jest.mock('@/features/tasks/hooks/useModelSelection', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react')

  const getModelKey = (model: { name: string; type?: string | null }) =>
    `${model.name}:${model.type || ''}`

  return {
    __esModule: true,
    DEFAULT_MODEL_NAME: '__default__',
    allBotsHavePredefinedModel: jest.fn(() => false),
    useModelSelection: () => {
      const [selectedModel, setSelectedModel] = React.useState(null)
      const [forceOverride, setForceOverride] = React.useState(false)

      return {
        selectedModel,
        forceOverride,
        models: selectedModel ? [selectedModel] : [],
        filteredModels: selectedModel ? [selectedModel] : [],
        isLoading: false,
        error: null,
        showDefaultOption: false,
        isModelRequired: false,
        isMixedTeam: false,
        compatibleProvider: null,
        hasAdvancedModels: false,
        selectModel: setSelectedModel,
        selectModelByKey: mockSelectModelByKey,
        selectDefaultModel: mockSelectDefaultModel,
        setForceOverride,
        showAdvancedModels: false,
        setShowAdvancedModels: mockSetShowAdvancedModels,
        refreshModels: mockRefreshModels,
        getDisplayText: () => {
          if (!selectedModel) {
            return 'Select model'
          }

          return selectedModel.displayName || selectedModel.name
        },
        getBoundModelDisplayNames: () => [],
        getModelKey,
        getModelDisplayText: (model: { displayName?: string | null; name: string }) =>
          model.displayName || model.name,
      }
    },
  }
})

const mockModel: Model = {
  name: 'claude-3-5-sonnet',
  displayName: 'Claude 3.5 Sonnet',
  provider: 'anthropic',
  modelId: 'claude-3-5-sonnet-20241022',
  type: 'shared' as Model['type'],
}

describe('ModelSelector', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('syncs an externally selected model into the selector display', async () => {
    const externalSetSelectedModel = jest.fn()
    const externalSetForceOverride = jest.fn()

    const { rerender } = render(
      <ModelSelector
        selectedModel={null}
        setSelectedModel={externalSetSelectedModel}
        forceOverride={false}
        setForceOverride={externalSetForceOverride}
        selectedTeam={null}
        disabled={false}
      />
    )

    expect(screen.getByTestId('model-selector')).toHaveTextContent('Select model')

    rerender(
      <ModelSelector
        selectedModel={mockModel}
        setSelectedModel={externalSetSelectedModel}
        forceOverride={false}
        setForceOverride={externalSetForceOverride}
        selectedTeam={null}
        disabled={false}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('model-selector')).toHaveTextContent('Claude 3.5 Sonnet')
    })
  })

  it('does not show override wording when external forceOverride is true', async () => {
    const externalSetSelectedModel = jest.fn()
    const externalSetForceOverride = jest.fn()

    const { rerender } = render(
      <ModelSelector
        selectedModel={mockModel}
        setSelectedModel={externalSetSelectedModel}
        forceOverride={false}
        setForceOverride={externalSetForceOverride}
        selectedTeam={null}
        disabled={false}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('model-selector')).toHaveTextContent('Claude 3.5 Sonnet')
    })

    rerender(
      <ModelSelector
        selectedModel={mockModel}
        setSelectedModel={externalSetSelectedModel}
        forceOverride={true}
        setForceOverride={externalSetForceOverride}
        selectedTeam={null}
        disabled={false}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('model-selector')).toHaveTextContent('Claude 3.5 Sonnet')
      expect(screen.getByTestId('model-selector')).not.toHaveTextContent('覆盖')
    })
  })

  it('does not show an override control in the dropdown', async () => {
    render(
      <ModelSelector
        selectedModel={mockModel}
        setSelectedModel={jest.fn()}
        forceOverride={true}
        setForceOverride={jest.fn()}
        selectedTeam={null}
        disabled={false}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('model-selector')).toHaveTextContent('Claude 3.5 Sonnet')
    })

    fireEvent.click(screen.getByTestId('model-selector'))

    await waitFor(() => {
      expect(screen.queryByText('覆盖默认模型')).not.toBeInTheDocument()
    })
  })
})
