// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { adminApis, type AdminPublicModel } from '@/apis/admin'
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
})
