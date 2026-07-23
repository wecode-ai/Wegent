// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
let mockModelSelectionOverrides: Record<string, unknown> = {}
let mockIsMobile = false

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      const translations: Record<string, string> = {
        'models.model_id': '模型 ID',
        'models.cost_index': '成本指数',
        'models.cost_index_description': '相对成本，1x 为基准；数值越高成本越高，不代表实际价格。',
        'models.details_unavailable': '暂无信息',
        'models.input_output_types': '输入输出类型',
        'models.input_type': '输入',
        'models.output_type': '输出',
        'models.modality_text': '文本',
        'models.modality_image': '图片',
        'models.modality_video': '视频',
        'models.modality_separator': '、',
        'models.token_unit': 'Tokens',
        'models.image_understanding': '图片理解',
        'models.video_understanding': '视频理解',
        'models.model_limits': '模型限制',
        'models.context_window': '上下文窗口',
        'models.max_output_tokens': '最大输出 Token',
      }
      return translations[key] ?? fallback ?? key
    },
  }),
}))

jest.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => mockIsMobile,
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
        ...mockModelSelectionOverrides,
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
  contextWindow: 1048576,
  maxOutputTokens: 131072,
  costIndex: 50,
  modelCapabilities: {
    supportsImage: true,
    supportsVideo: true,
  },
}

const mockAdvancedModel: Model = {
  name: 'claude-opus-4-advanced',
  displayName: 'Claude Opus 4 Advanced',
  provider: 'anthropic',
  modelId: 'claude-opus-4-advanced',
  type: 'shared' as Model['type'],
  isAdvanced: true,
}

const mockDefaultModel: Model = {
  name: '__default__',
  provider: '',
  modelId: '',
}

describe('ModelSelector', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockModelSelectionOverrides = {}
    mockIsMobile = false
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

  it('keeps model settings left aligned and the advanced model toggle on the right', async () => {
    mockModelSelectionOverrides = {
      hasAdvancedModels: true,
      showAdvancedModels: false,
    }

    render(
      <ModelSelector
        selectedModel={mockModel}
        setSelectedModel={jest.fn()}
        forceOverride={false}
        setForceOverride={jest.fn()}
        selectedTeam={null}
        disabled={false}
      />
    )

    fireEvent.click(screen.getByTestId('model-selector'))

    const footer = await screen.findByTestId('model-selector-footer')
    const settingsButton = screen.getByTestId('model-settings-button')
    const advancedToggle = screen.getByTestId('show-advanced-models-toggle')

    expect(footer).toHaveClass('flex')
    expect(footer).toHaveClass('justify-between')
    expect(
      settingsButton.compareDocumentPosition(advancedToggle) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(advancedToggle).toHaveClass('ml-auto')
    expect(settingsButton).toHaveTextContent('Model settings')
    expect(advancedToggle).toHaveTextContent('Show advanced models')
  })

  it('marks advanced models with a distinct badge when they are visible', async () => {
    mockModelSelectionOverrides = {
      filteredModels: [mockAdvancedModel],
      hasAdvancedModels: true,
      showAdvancedModels: true,
    }

    render(
      <ModelSelector
        selectedModel={null}
        setSelectedModel={jest.fn()}
        forceOverride={false}
        setForceOverride={jest.fn()}
        selectedTeam={null}
        disabled={false}
      />
    )

    fireEvent.click(screen.getByTestId('model-selector'))

    const advancedBadge = await screen.findByTestId('model-advanced-badge')

    expect(screen.getByText('Claude Opus 4 Advanced')).toBeInTheDocument()
    expect(advancedBadge).toHaveTextContent('Advanced')
    expect(advancedBadge).toHaveClass('bg-warning/10')
    expect(advancedBadge).toHaveClass('text-warning')
  })

  it('shows advanced models by default when the current selection is advanced', async () => {
    mockModelSelectionOverrides = {
      selectedModel: mockAdvancedModel,
      filteredModels: [mockModel],
      hasAdvancedModels: true,
      showAdvancedModels: false,
    }

    render(
      <ModelSelector
        selectedModel={mockAdvancedModel}
        setSelectedModel={jest.fn()}
        forceOverride={false}
        setForceOverride={jest.fn()}
        selectedTeam={null}
        disabled={false}
      />
    )

    fireEvent.click(screen.getByTestId('model-selector'))

    await waitFor(() => {
      expect(mockSetShowAdvancedModels).toHaveBeenCalledWith(true)
    })
  })

  it('shows advanced models by default when the bot preset model is advanced', async () => {
    mockModelSelectionOverrides = {
      selectedModel: mockDefaultModel,
      boundDefaultModel: mockAdvancedModel,
      filteredModels: [mockModel],
      hasAdvancedModels: true,
      showAdvancedModels: false,
      showDefaultOption: true,
    }

    render(
      <ModelSelector
        selectedModel={mockDefaultModel}
        setSelectedModel={jest.fn()}
        forceOverride={false}
        setForceOverride={jest.fn()}
        selectedTeam={null}
        disabled={false}
      />
    )

    fireEvent.click(screen.getByTestId('model-selector'))

    await waitFor(() => {
      expect(mockSetShowAdvancedModels).toHaveBeenCalledWith(true)
    })
  })

  it('highlights the actual bot preset model when the default selection resolves to a model', async () => {
    mockModelSelectionOverrides = {
      selectedModel: mockDefaultModel,
      boundDefaultModel: mockAdvancedModel,
      filteredModels: [mockAdvancedModel],
      hasAdvancedModels: true,
      showAdvancedModels: true,
      showDefaultOption: true,
    }

    render(
      <ModelSelector
        selectedModel={mockDefaultModel}
        setSelectedModel={jest.fn()}
        forceOverride={false}
        setForceOverride={jest.fn()}
        selectedTeam={null}
        disabled={false}
      />
    )

    fireEvent.click(screen.getByTestId('model-selector'))

    const modelOption = await screen.findByTestId('model-option-claude-opus-4-advanced')

    expect(modelOption.parentElement).toHaveClass('bg-primary/10')
    expect(modelOption.parentElement).toHaveClass('text-primary')
    const defaultOption = screen.getByTestId('model-special-option-__default__')
    expect(defaultOption).toHaveClass('bg-primary/10')
    expect(defaultOption.querySelector('.lucide-check')).not.toBeInTheDocument()
  })

  it('covers the information action with the selected row background', async () => {
    mockModelSelectionOverrides = {
      selectedModel: mockModel,
      filteredModels: [mockModel],
    }

    render(
      <ModelSelector
        selectedModel={mockModel}
        setSelectedModel={jest.fn()}
        forceOverride={false}
        setForceOverride={jest.fn()}
        selectedTeam={null}
        disabled={false}
      />
    )

    fireEvent.click(screen.getByTestId('model-selector'))

    const modelOption = await screen.findByTestId('model-option-claude-3-5-sonnet')
    const informationAction = screen.getByTestId('model-info-claude-3-5-sonnet')
    const modelTitle = screen.getByTitle('Claude 3.5 Sonnet')

    expect(modelOption.parentElement).toBe(informationAction.parentElement)
    expect(modelOption.parentElement).toHaveClass('items-stretch')
    expect(modelOption.parentElement).toHaveClass('overflow-hidden')
    expect(modelOption.parentElement).toHaveClass('grid-cols-[minmax(0,1fr)_auto_32px]')
    expect(modelOption.parentElement).toHaveClass('bg-primary/10')
    expect(modelOption).toHaveClass('flex', 'items-center', 'gap-3', 'px-3')
    expect(modelTitle).toHaveClass('block', 'truncate')
    expect(modelTitle).not.toHaveClass('flex-1')
    expect(
      screen.getByRole('button', { name: '图片理解' }).querySelector('.lucide-image')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '视频理解' }).querySelector('.lucide-video')
    ).toBeInTheDocument()
    expect(modelOption.querySelector('.lucide-check')).not.toBeInTheDocument()
    expect(informationAction).toHaveClass('self-stretch', 'items-center', 'w-11', 'md:w-8')
    expect(informationAction).not.toHaveClass('pt-3')
  })

  it('shows an information action when model detail metadata is unavailable', async () => {
    mockModelSelectionOverrides = {
      filteredModels: [mockAdvancedModel],
    }

    render(
      <ModelSelector
        selectedModel={null}
        setSelectedModel={jest.fn()}
        forceOverride={false}
        setForceOverride={jest.fn()}
        selectedTeam={null}
        disabled={false}
      />
    )

    fireEvent.click(screen.getByTestId('model-selector'))

    expect(await screen.findByTestId('model-option-claude-opus-4-advanced')).toBeInTheDocument()
    expect(screen.getByTestId('model-info-claude-opus-4-advanced')).toBeInTheDocument()
  })

  it('does not show model information on mobile', async () => {
    const externalSetSelectedModel = jest.fn()
    mockIsMobile = true
    mockModelSelectionOverrides = {
      filteredModels: [mockModel],
    }

    render(
      <ModelSelector
        selectedModel={null}
        setSelectedModel={externalSetSelectedModel}
        forceOverride={false}
        setForceOverride={jest.fn()}
        selectedTeam={null}
        disabled={false}
      />
    )

    fireEvent.click(screen.getByTestId('model-selector'))
    expect(await screen.findByTestId('model-option-claude-3-5-sonnet')).toBeInTheDocument()
    expect(screen.queryByTestId('model-info-claude-3-5-sonnet')).not.toBeInTheDocument()
    expect(externalSetSelectedModel).not.toHaveBeenCalled()
  })

  it('shows full model details in a non-modal layer when hovering', async () => {
    const user = userEvent.setup()
    mockModelSelectionOverrides = {
      filteredModels: [mockModel],
    }

    render(
      <ModelSelector
        selectedModel={null}
        setSelectedModel={jest.fn()}
        forceOverride={false}
        setForceOverride={jest.fn()}
        selectedTeam={null}
        disabled={false}
      />
    )

    fireEvent.click(screen.getByTestId('model-selector'))
    await user.hover(await screen.findByTestId('model-info-claude-3-5-sonnet'))

    const preview = await screen.findByTestId('model-details-preview')
    expect(preview).toHaveTextContent('claude-3-5-sonnet-20241022')
    expect(preview).toHaveTextContent('50x')
    expect(preview).not.toHaveTextContent('相对成本，1x 为基准；数值越高成本越高，不代表实际价格。')

    expect(preview.querySelector('[data-testid="model-details-cost-index-help"]')).toHaveAttribute(
      'title',
      '相对成本，1x 为基准；数值越高成本越高，不代表实际价格。'
    )
  })

  it('omits the cost index section when the model has no cost index', async () => {
    const user = userEvent.setup()
    mockModelSelectionOverrides = {
      filteredModels: [mockAdvancedModel],
    }

    render(
      <ModelSelector
        selectedModel={null}
        setSelectedModel={jest.fn()}
        forceOverride={false}
        setForceOverride={jest.fn()}
        selectedTeam={null}
        disabled={false}
      />
    )

    fireEvent.click(screen.getByTestId('model-selector'))
    await user.hover(await screen.findByTestId('model-info-claude-opus-4-advanced'))

    expect(await screen.findByTestId('model-details-preview')).toBeInTheDocument()
    expect(screen.queryByTestId('model-details-cost-index')).not.toBeInTheDocument()
    expect(screen.queryByText('成本指数')).not.toBeInTheDocument()
  })
})
