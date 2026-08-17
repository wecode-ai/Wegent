// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { resourceLibraryApi } from '@/apis/resourceLibrary'
import { MarketplaceTagSelector } from '@/features/resource-library/components/MarketplaceTagSelector'

jest.mock('@/apis/resourceLibrary', () => ({
  resourceLibraryApi: {
    getMarketplaceTags: jest.fn(),
  },
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { max?: number }) =>
      key === 'marketplace_tags.disabled'
        ? '已停用'
        : key === 'marketplace_tags.selection_hint'
          ? `最多 ${options?.max} 个`
          : key,
    i18n: { language: 'zh-CN' },
  }),
}))

const mockedApi = resourceLibraryApi as jest.Mocked<typeof resourceLibraryApi>

describe('MarketplaceTagSelector', () => {
  beforeEach(() => {
    mockedApi.getMarketplaceTags.mockResolvedValue({
      version: 1,
      items: [
        {
          id: 'disabled_tag',
          name_zh: '历史标签',
          name_en: 'Legacy',
          sort: 5,
          enabled: false,
        },
        {
          id: 'technical_development',
          name_zh: '技术开发',
          name_en: 'Technical Development',
          sort: 10,
          enabled: true,
        },
        {
          id: 'unused_disabled_tag',
          name_zh: '未使用停用标签',
          name_en: 'Unused Disabled',
          sort: 15,
          enabled: false,
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
  })

  it('allows removing selected disabled tags and selects enabled tags', async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()

    render(<MarketplaceTagSelector value={['disabled_tag']} onChange={onChange} maxTags={3} />)

    const disabledTag = await screen.findByTestId('marketplace-tag-option-disabled_tag')
    expect(disabledTag).toBeEnabled()
    expect(disabledTag).toHaveTextContent('历史标签 (已停用)')
    expect(
      screen.queryByTestId('marketplace-tag-option-unused_disabled_tag')
    ).not.toBeInTheDocument()

    await user.click(disabledTag)
    expect(onChange).toHaveBeenCalledWith([])
    onChange.mockClear()

    await user.click(screen.getByTestId('marketplace-tag-option-technical_development'))

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(['disabled_tag', 'technical_development'])
    )
  })

  it('prevents selecting more than the configured maximum', async () => {
    render(
      <MarketplaceTagSelector value={['technical_development']} onChange={jest.fn()} maxTags={1} />
    )

    expect(await screen.findByTestId('marketplace-tag-option-data_analysis')).toBeDisabled()
  })
})
