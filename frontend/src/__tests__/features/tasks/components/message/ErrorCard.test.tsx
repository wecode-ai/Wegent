// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ErrorCard } from '@/features/tasks/components/message/ErrorCard'
import type { Message } from '@/features/tasks/components/message/MessageBubble'

const mockGetRecommendedModels = jest.fn()
const mockUseErrorRecommendations = jest.fn()

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => options?.model ?? key,
  }),
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({
    user: {
      id: 1,
      user_name: 'tester',
    },
  }),
}))

jest.mock('@/features/tasks/hooks/useErrorRecommendations', () => ({
  useErrorRecommendations: () => mockUseErrorRecommendations(),
}))

function getRecommendedModel() {
  return {
    name: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    provider: 'google',
    modelId: 'gemini-2.5-pro',
    type: 'public',
  }
}

function createErrorMessage(timestamp: number, error: string): Message {
  return {
    type: 'ai',
    content: '',
    timestamp,
    subtaskId: 42,
    status: 'error',
    error,
    errorType: 'model_unavailable',
  }
}

describe('ErrorCard', () => {
  beforeEach(() => {
    localStorage.clear()
    jest.clearAllMocks()
    mockGetRecommendedModels.mockImplementation((errorType: string) =>
      errorType === 'model_unavailable' ? [getRecommendedModel()] : []
    )
    mockUseErrorRecommendations.mockReturnValue({
      getRecommendedModels: mockGetRecommendedModels,
      isLoading: false,
    })
  })

  it('does not show current-model retry while recommendations are still loading', () => {
    mockUseErrorRecommendations.mockReturnValue({
      getRecommendedModels: mockGetRecommendedModels,
      isLoading: true,
    })

    render(
      <ErrorCard
        error="rate limit exceeded"
        errorType="rate_limit"
        subtaskId={42}
        taskId={100}
        timestamp={1000}
        message={{
          ...createErrorMessage(1000, 'rate limit exceeded'),
          errorType: 'rate_limit',
        }}
        isLastErrorMessage={true}
        onRetry={jest.fn()}
      />
    )

    expect(screen.queryByTestId('error-card-retry')).not.toBeInTheDocument()
    expect(mockGetRecommendedModels).toHaveBeenCalledWith('rate_limit')
  })

  it('reopens a new last-error instance after switch-model retry fails again', async () => {
    const user = userEvent.setup()
    const onRetryWithModel = jest.fn().mockResolvedValue(true)

    const { rerender } = render(
      <ErrorCard
        error="original model failed"
        errorType="model_unavailable"
        subtaskId={42}
        taskId={100}
        timestamp={1000}
        message={createErrorMessage(1000, 'original model failed')}
        isLastErrorMessage={true}
        onRetryWithModel={onRetryWithModel}
      />
    )

    await user.click(screen.getByTestId('error-card-model-recommend-gemini-2.5-pro'))

    expect(onRetryWithModel).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('error-card-collapsed')).toBeInTheDocument()

    rerender(
      <ErrorCard
        error="fallback model also failed"
        errorType="model_unavailable"
        subtaskId={42}
        taskId={100}
        timestamp={2000}
        message={createErrorMessage(2000, 'fallback model also failed')}
        isLastErrorMessage={true}
        onRetryWithModel={onRetryWithModel}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('error-card')).toBeInTheDocument()
    })

    expect(screen.queryByTestId('error-card-collapsed')).not.toBeInTheDocument()
  })

  it('uses the backend error type when looking up model recommendations', () => {
    render(
      <ErrorCard
        error="original model failed"
        errorType="model_unavailable"
        subtaskId={42}
        taskId={100}
        timestamp={1000}
        message={createErrorMessage(1000, 'original model failed')}
        isLastErrorMessage={true}
      />
    )

    expect(mockGetRecommendedModels).toHaveBeenCalledWith('model_unavailable')
    expect(screen.getByTestId('error-card-model-recommend-gemini-2.5-pro')).toBeInTheDocument()
  })

  it('keeps the error card open when retry fails', async () => {
    const user = userEvent.setup()
    const onRetry = jest.fn().mockResolvedValue(false)

    render(
      <ErrorCard
        error="original model failed"
        errorType="model_unavailable"
        subtaskId={42}
        taskId={100}
        timestamp={1000}
        message={createErrorMessage(1000, 'original model failed')}
        isLastErrorMessage={true}
        onRetry={onRetry}
      />
    )

    expect(screen.getByText('errors.retry_with_current_model')).toBeInTheDocument()
    expect(screen.queryByText('errors.wait_and_retry')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('error-card-retry'))

    await waitFor(() => {
      expect(onRetry).toHaveBeenCalledTimes(1)
    })
    expect(screen.getByTestId('error-card')).toBeInTheDocument()
    expect(screen.queryByTestId('error-card-collapsed')).not.toBeInTheDocument()
  })

  it('falls back to textarea copy when navigator.clipboard is unavailable', async () => {
    const user = userEvent.setup()
    const clipboardWriteText = jest
      .spyOn(navigator.clipboard, 'writeText')
      .mockRejectedValue(new Error('clipboard unavailable'))
    const execCommand = jest.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    })

    render(
      <ErrorCard
        error="original model failed"
        errorType="model_unavailable"
        subtaskId={42}
        taskId={100}
        timestamp={1000}
        message={createErrorMessage(1000, 'original model failed')}
        isLastErrorMessage={true}
      />
    )

    await user.click(screen.getByTestId('error-card-copy-developer'))

    await waitFor(() => {
      expect(execCommand).toHaveBeenCalledWith('copy')
    })
    expect(clipboardWriteText).toHaveBeenCalledTimes(1)
    expect(screen.getByText('errors.copy_diagnostic_success')).toBeInTheDocument()
  })
})
