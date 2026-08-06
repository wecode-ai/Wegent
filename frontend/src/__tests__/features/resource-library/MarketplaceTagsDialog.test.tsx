// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { resourceLibraryApi } from '@/apis/resourceLibrary'
import { MarketplaceTagsDialog } from '@/features/resource-library/components/MarketplaceTagsDialog'
import type { ResourceLibraryListing } from '@/features/resource-library/types'

jest.mock('@/apis/resourceLibrary', () => ({
  resourceLibraryApi: {
    getPublication: jest.fn(),
    getMarketplaceTags: jest.fn(),
    updatePublication: jest.fn(),
  },
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

const mockedApi = resourceLibraryApi as jest.Mocked<typeof resourceLibraryApi>

describe('MarketplaceTagsDialog', () => {
  beforeEach(() => {
    mockedApi.getPublication.mockResolvedValue({
      id: 7,
      tags: ['technical_development'],
    } as ResourceLibraryListing)
    mockedApi.getMarketplaceTags.mockResolvedValue({
      version: 1,
      items: [
        {
          id: 'technical_development',
          name_zh: '技术开发',
          name_en: 'Technical Development',
          sort: 10,
          enabled: true,
        },
        {
          id: 'data_analysis',
          name_zh: '数据分析',
          name_en: 'Data Analysis',
          sort: 20,
          enabled: true,
        },
      ],
    })
    mockedApi.updatePublication.mockResolvedValue({} as ResourceLibraryListing)
  })

  it('updates only marketplace tags', async () => {
    const user = userEvent.setup()
    const onOpenChange = jest.fn()

    render(<MarketplaceTagsDialog resourceId={7} open onOpenChange={onOpenChange} />)

    await user.click(await screen.findByTestId('marketplace-tag-option-data_analysis'))
    await user.click(screen.getByTestId('marketplace-tags-dialog-save'))

    await waitFor(() =>
      expect(mockedApi.updatePublication).toHaveBeenCalledWith(7, {
        tags: ['technical_development', 'data_analysis'],
      })
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
