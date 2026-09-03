// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { adminApis } from '@/apis/admin'
import MarketplaceManagement from '@/features/admin/components/MarketplaceManagement'

jest.mock('@/apis/admin', () => ({
  adminApis: {
    getMarketplaceResources: jest.fn(),
    updateMarketplaceResource: jest.fn(),
  },
}))

const toastMock = jest.fn()
const tMock = (key: string) => key

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: tMock }),
}))

const mockedAdminApis = adminApis as jest.Mocked<typeof adminApis>
describe('MarketplaceManagement', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedAdminApis.getMarketplaceResources.mockImplementation(async resourceType => ({
      items: [
        {
          id: resourceType === 'agent' ? 11 : 22,
          resource_type: resourceType,
          name: `${resourceType}-resource`,
          display_name: `${resourceType} resource`,
          description: null,
          publisher_user_name: null,
          is_system: true,
          recommendation_score: 0,
          example_conversations: [],
        },
      ],
      total: 1,
      page: 1,
      limit: 50,
    }))
    mockedAdminApis.updateMarketplaceResource.mockImplementation(async (resourceId, update) => ({
      id: resourceId,
      resource_type: 'agent',
      name: 'agent-resource',
      display_name: 'agent resource',
      description: null,
      publisher_user_name: null,
      is_system: true,
      recommendation_score: update.recommendation_score || 0,
      example_conversations: update.example_conversations || [],
    }))
  })

  it('loads both marketplace tabs and updates the recommendation score', async () => {
    render(<MarketplaceManagement />)

    await screen.findByText('agent resource')
    fireEvent.click(screen.getByTestId('marketplace-recommendation-score-11'))
    fireEvent.change(screen.getByTestId('marketplace-recommendation-score-input'), {
      target: { value: '90' },
    })
    fireEvent.click(screen.getByTestId('marketplace-recommendation-score-save'))

    await waitFor(() =>
      expect(mockedAdminApis.updateMarketplaceResource).toHaveBeenCalledWith(11, {
        recommendation_score: 90,
      })
    )

    fireEvent.click(screen.getByTestId('marketplace-example-conversations-toggle-11'))
    fireEvent.click(screen.getByTestId('marketplace-example-conversations-11-add'))
    fireEvent.change(screen.getByTestId('marketplace-example-conversations-11-title-0'), {
      target: { value: 'Example conversation' },
    })
    fireEvent.change(screen.getByTestId('marketplace-example-conversations-11-url-0'), {
      target: { value: 'https://example.com/shared/conversation' },
    })
    fireEvent.click(screen.getByTestId('marketplace-example-conversations-save-11'))

    await waitFor(() =>
      expect(mockedAdminApis.updateMarketplaceResource).toHaveBeenCalledWith(11, {
        example_conversations: [
          {
            title: 'Example conversation',
            url: 'https://example.com/shared/conversation',
          },
        ],
      })
    )

    fireEvent.mouseDown(screen.getByTestId('marketplace-management-tab-skill'))

    await waitFor(() =>
      expect(mockedAdminApis.getMarketplaceResources).toHaveBeenLastCalledWith('skill', 1, 50)
    )
    expect(await screen.findByText('skill resource')).toBeInTheDocument()
  })
})
