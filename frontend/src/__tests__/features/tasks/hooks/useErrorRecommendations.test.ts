// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { renderHook, waitFor } from '@testing-library/react'

import type { ErrorRecommendationEntry, UnifiedModel } from '@/apis/models'
import {
  __resetErrorRecommendationsCacheForTests,
  DEFAULT_ERROR_RECOMMENDATION_KEY,
  getRecommendedModelsForError,
  useErrorRecommendations,
} from '@/features/tasks/hooks/useErrorRecommendations'

const mockGetErrorRecommendations = jest.fn()

jest.mock('@/apis/models', () => ({
  modelApis: {
    getErrorRecommendations: (...args: unknown[]) => mockGetErrorRecommendations(...args),
  },
}))

function createRecommendedModel(name: string): UnifiedModel {
  return {
    name,
    type: 'public',
    displayName: name,
    provider: 'openai',
    modelId: name,
  }
}

describe('getRecommendedModelsForError', () => {
  beforeEach(() => {
    __resetErrorRecommendationsCacheForTests()
    mockGetErrorRecommendations.mockReset()
  })

  test('prefers an explicit error-type recommendation over default_errors', () => {
    const specificModel = createRecommendedModel('gemini-2.5-pro')
    const fallbackModel = createRecommendedModel('claude-sonnet-4')
    const recommendations: Record<string, ErrorRecommendationEntry> = {
      rate_limit: {
        description: 'Alternative models to avoid rate limits',
        models: [specificModel],
      },
      [DEFAULT_ERROR_RECOMMENDATION_KEY]: {
        description: 'Fallback models for unmapped errors',
        models: [fallbackModel],
      },
    }

    expect(getRecommendedModelsForError(recommendations, 'rate_limit')).toEqual([specificModel])
  })

  test('uses alias recommendations before default_errors', () => {
    const aliasModel = createRecommendedModel('gemini-2.5-pro')
    const fallbackModel = createRecommendedModel('claude-sonnet-4')
    const recommendations: Record<string, ErrorRecommendationEntry> = {
      llm_error: {
        description: 'Fallback for model unavailable errors',
        models: [aliasModel],
      },
      [DEFAULT_ERROR_RECOMMENDATION_KEY]: {
        description: 'Fallback models for unmapped errors',
        models: [fallbackModel],
      },
    }

    expect(getRecommendedModelsForError(recommendations, 'model_unavailable')).toEqual([aliasModel])
  })

  test('uses default_errors when the error type is not configured', () => {
    const fallbackModel = createRecommendedModel('claude-sonnet-4')
    const recommendations: Record<string, ErrorRecommendationEntry> = {
      [DEFAULT_ERROR_RECOMMENDATION_KEY]: {
        description: 'Fallback models for unmapped errors',
        models: [fallbackModel],
      },
    }

    expect(getRecommendedModelsForError(recommendations, 'provider_timeout')).toEqual([
      fallbackModel,
    ])
  })

  test('does not fall back to default_errors when the error type is explicitly configured as empty', () => {
    const fallbackModel = createRecommendedModel('claude-sonnet-4')
    const recommendations: Record<string, ErrorRecommendationEntry> = {
      provider_timeout: {
        description: 'Explicitly disable model recommendations',
        models: [],
      },
      [DEFAULT_ERROR_RECOMMENDATION_KEY]: {
        description: 'Fallback models for unmapped errors',
        models: [fallbackModel],
      },
    }

    expect(getRecommendedModelsForError(recommendations, 'provider_timeout')).toEqual([])
  })

  test.each([
    {
      title: 'returns empty when default_errors is missing',
      recommendations: {},
    },
    {
      title: 'returns empty when default_errors has no models',
      recommendations: {
        [DEFAULT_ERROR_RECOMMENDATION_KEY]: {
          description: 'Fallback models for unmapped errors',
          models: [],
        },
      },
    },
  ])('$title', ({ recommendations }) => {
    expect(
      getRecommendedModelsForError(
        recommendations as Record<string, ErrorRecommendationEntry>,
        'provider_timeout'
      )
    ).toEqual([])
  })

  test('deduplicates concurrent initial fetches across hook instances', async () => {
    const responseData: Record<string, ErrorRecommendationEntry> = {
      rate_limit: {
        description: 'Alternative models to avoid rate limits',
        models: [createRecommendedModel('gemini-2.5-pro')],
      },
    }
    let resolveRequest:
      | ((value: { data: Record<string, ErrorRecommendationEntry> }) => void)
      | undefined

    mockGetErrorRecommendations.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveRequest = resolve
        })
    )

    const firstHook = renderHook(() => useErrorRecommendations())
    const secondHook = renderHook(() => useErrorRecommendations())

    await waitFor(() => {
      expect(firstHook.result.current.isLoading).toBe(true)
      expect(secondHook.result.current.isLoading).toBe(true)
    })

    expect(mockGetErrorRecommendations).toHaveBeenCalledTimes(1)

    resolveRequest?.({ data: responseData })

    await waitFor(() => {
      expect(firstHook.result.current.isLoading).toBe(false)
      expect(secondHook.result.current.isLoading).toBe(false)
    })

    expect(firstHook.result.current.recommendations).toEqual(responseData)
    expect(secondHook.result.current.recommendations).toEqual(responseData)
  })
})
