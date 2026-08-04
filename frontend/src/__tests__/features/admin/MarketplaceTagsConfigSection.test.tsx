// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { adminApis } from '@/apis/admin'
import { MarketplaceTagsConfigSection } from '@/features/admin/components/MarketplaceTagsConfigSection'

jest.mock('@/apis/admin', () => ({
  adminApis: {
    getMarketplaceTagsConfig: jest.fn(),
    updateMarketplaceTagsConfig: jest.fn(),
  },
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const mockedApi = adminApis as jest.Mocked<typeof adminApis>

describe('MarketplaceTagsConfigSection', () => {
  beforeEach(() => {
    mockedApi.getMarketplaceTagsConfig.mockResolvedValue({
      version: 1,
      items: [
        {
          id: 'technical_development',
          name_zh: '技术开发',
          name_en: 'Technical Development',
          sort: 20,
          enabled: true,
        },
      ],
    })
    mockedApi.updateMarketplaceTagsConfig.mockImplementation(async request => ({
      version: 2,
      items: request.items,
    }))
  })

  it('edits labels, sort and enabled state, then saves the full catalog', async () => {
    const user = userEvent.setup()
    render(<MarketplaceTagsConfigSection />)

    expect(await screen.findByTestId('marketplace-tag-id-0')).toBeDisabled()
    fireEvent.change(screen.getByTestId('marketplace-tag-name-zh-0'), {
      target: { value: '研发技术' },
    })
    fireEvent.change(screen.getByTestId('marketplace-tag-sort-0'), {
      target: { value: '5' },
    })
    await user.click(screen.getByTestId('marketplace-tag-enabled-0'))
    await user.click(screen.getByTestId('marketplace-tags-save'))

    await waitFor(() =>
      expect(mockedApi.updateMarketplaceTagsConfig).toHaveBeenCalledWith({
        expected_version: 1,
        items: [
          {
            id: 'technical_development',
            name_zh: '研发技术',
            name_en: 'Technical Development',
            sort: 5,
            enabled: false,
          },
        ],
      })
    )
  })
})
