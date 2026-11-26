// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { adminApis, type AdminPublicModel, type AdminPublicModelListResponse } from '@/apis/admin'
import PublicModelList from '@/features/admin/components/PublicModelList'

const mockReplace = jest.fn()
const mockSearchParamsRef = { current: new URLSearchParams() }

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParamsRef.current,
}))

jest.mock('@/hooks/useTranslation', () => {
  const t = (key: string, options?: { search?: string }) => {
    const search = options?.search
    return search ? `${key}:${search}` : key
  }
  return { useTranslation: () => ({ t }) }
})

jest.mock('@/hooks/use-toast', () => {
  const toast = jest.fn()
  return { useToast: () => ({ toast }) }
})

jest.mock('@/apis/admin', () => ({
  adminApis: {
    getPublicModels: jest.fn(),
    createPublicModel: jest.fn(),
    updatePublicModel: jest.fn(),
    deletePublicModel: jest.fn(),
  },
}))

const model: AdminPublicModel = {
  id: 1,
  name: 'ali-qwen3.8-flash',
  namespace: 'default',
  display_name: 'Qwen3.8-Flash',
  json: { kind: 'Model', spec: {} },
  is_active: true,
  is_visible: true,
  is_advanced: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const mockedAdminApis = jest.mocked(adminApis)

describe('PublicModelList search and pagination URL state', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSearchParamsRef.current = new URLSearchParams('tab=public-models')
    mockedAdminApis.getPublicModels.mockResolvedValue({ items: [model], total: 120 })
  })

  test('restores the search and page from the URL', async () => {
    mockSearchParamsRef.current = new URLSearchParams('tab=public-models&search=qwen&page=2')

    render(<PublicModelList />)

    await waitFor(() => expect(mockedAdminApis.getPublicModels).toHaveBeenCalledWith(2, 50, 'qwen'))
    expect(screen.getByTestId('public-model-search-input')).toHaveValue('qwen')
  })

  test('commits a new search to the URL and returns to the first page', async () => {
    mockSearchParamsRef.current = new URLSearchParams('tab=public-models&page=3')

    render(<PublicModelList />)

    await waitFor(() =>
      expect(mockedAdminApis.getPublicModels).toHaveBeenCalledWith(3, 50, undefined)
    )

    fireEvent.change(screen.getByTestId('public-model-search-input'), {
      target: { value: 'qwen' },
    })

    await waitFor(
      () => expect(mockedAdminApis.getPublicModels).toHaveBeenCalledWith(1, 50, 'qwen'),
      { timeout: 1500 }
    )
    expect(mockReplace).toHaveBeenCalledWith('?tab=public-models&search=qwen', {
      scroll: false,
    })
  })

  test('writes the selected page to the URL', async () => {
    render(<PublicModelList />)

    await waitFor(() => expect(screen.getByTestId('pagination-page-2')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('pagination-page-2'))

    await waitFor(() =>
      expect(mockedAdminApis.getPublicModels).toHaveBeenCalledWith(2, 50, undefined)
    )
    expect(mockReplace).toHaveBeenCalledWith('?tab=public-models&page=2', { scroll: false })
  })

  test('does not let a stale response overwrite newer search results', async () => {
    const oldModel: AdminPublicModel = {
      ...model,
      id: 2,
      name: 'old-model',
      display_name: 'Old Model',
    }
    const newModel: AdminPublicModel = {
      ...model,
      id: 3,
      name: 'new-model',
      display_name: 'New Model',
    }
    const resolvers: Array<(value: AdminPublicModelListResponse) => void> = []
    mockedAdminApis.getPublicModels.mockImplementation(
      () =>
        new Promise(resolve => {
          resolvers.push(resolve)
        })
    )
    mockSearchParamsRef.current = new URLSearchParams('tab=public-models&search=old')

    render(<PublicModelList />)

    await waitFor(() => expect(mockedAdminApis.getPublicModels).toHaveBeenCalledWith(1, 50, 'old'))

    fireEvent.change(screen.getByTestId('public-model-search-input'), {
      target: { value: 'new' },
    })

    await waitFor(
      () => expect(mockedAdminApis.getPublicModels).toHaveBeenCalledWith(1, 50, 'new'),
      { timeout: 1500 }
    )

    resolvers[1]({ items: [newModel], total: 1 })
    resolvers[0]({ items: [oldModel], total: 500 })

    await waitFor(() => expect(screen.getByText('New Model')).toBeInTheDocument())
    expect(screen.queryByText('Old Model')).not.toBeInTheDocument()
    expect(screen.queryByTestId('pagination-page-2')).not.toBeInTheDocument()
  })

  test('shows a retryable error instead of stale results when a new search fails', async () => {
    const oldModel: AdminPublicModel = {
      ...model,
      id: 2,
      name: 'old-model',
      display_name: 'Old Model',
    }
    const newModel: AdminPublicModel = {
      ...model,
      id: 3,
      name: 'new-model',
      display_name: 'New Model',
    }
    mockedAdminApis.getPublicModels
      .mockResolvedValueOnce({ items: [oldModel], total: 1 })
      .mockRejectedValueOnce(new Error('search failed'))
      .mockResolvedValueOnce({ items: [newModel], total: 1 })
    mockSearchParamsRef.current = new URLSearchParams('tab=public-models&search=old')

    render(<PublicModelList />)

    await waitFor(() => expect(screen.getByText('Old Model')).toBeInTheDocument())

    fireEvent.change(screen.getByTestId('public-model-search-input'), {
      target: { value: 'new' },
    })

    await waitFor(() => expect(screen.getByTestId('public-model-load-retry')).toBeInTheDocument(), {
      timeout: 1500,
    })
    expect(screen.queryByText('Old Model')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('public-model-load-retry'))

    await waitFor(() => expect(screen.getByText('New Model')).toBeInTheDocument())
  })

  test('keeps the requested page when the initial request fails', async () => {
    mockSearchParamsRef.current = new URLSearchParams('tab=public-models&page=3')
    mockedAdminApis.getPublicModels.mockRejectedValue(new Error('load failed'))

    render(<PublicModelList />)

    await waitFor(() => expect(screen.getByTestId('public-model-load-retry')).toBeInTheDocument())
    expect(mockedAdminApis.getPublicModels).toHaveBeenCalledTimes(1)
    expect(mockedAdminApis.getPublicModels).toHaveBeenCalledWith(3, 50, undefined)
    expect(mockReplace).not.toHaveBeenCalled()
  })

  test('does not show the previous page when a page change fails', async () => {
    const firstPageModel: AdminPublicModel = {
      ...model,
      id: 4,
      name: 'first-page-model',
      display_name: 'First Page Model',
    }
    mockedAdminApis.getPublicModels
      .mockResolvedValueOnce({ items: [firstPageModel], total: 120 })
      .mockRejectedValueOnce(new Error('page failed'))

    render(<PublicModelList />)

    await waitFor(() => expect(screen.getByText('First Page Model')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('pagination-page-2'))

    await waitFor(() => expect(screen.getByTestId('public-model-load-retry')).toBeInTheDocument())
    expect(screen.queryByText('First Page Model')).not.toBeInTheDocument()
    expect(screen.getByTestId('pagination-page-1')).toBeInTheDocument()
  })
})
