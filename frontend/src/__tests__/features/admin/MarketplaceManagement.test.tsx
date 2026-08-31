// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { adminApis } from '@/apis/admin'
import { adminPluginPublicationApis } from '@/apis/admin-plugin-publications'
import MarketplaceManagement from '@/features/admin/components/MarketplaceManagement'

const routerReplaceMock = jest.fn()
let searchParamsMock = new URLSearchParams()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: routerReplaceMock }),
  useSearchParams: () => searchParamsMock,
}))

jest.mock('@/apis/admin', () => ({
  adminApis: {
    getMarketplaceResources: jest.fn(),
    updateMarketplaceResource: jest.fn(),
  },
}))

jest.mock('@/apis/admin-plugin-publications', () => ({
  adminPluginPublicationApis: {
    listPublicationRequests: jest.fn(),
    getPublicationRequest: jest.fn(),
    returnPublicationRequest: jest.fn(),
    acceptPublicationRequest: jest.fn(),
    reconcilePublicationRequest: jest.fn(),
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
const mockedPublicationApis = adminPluginPublicationApis as jest.Mocked<
  typeof adminPluginPublicationApis
>

describe('MarketplaceManagement', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    searchParamsMock = new URLSearchParams()
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
    mockedPublicationApis.listPublicationRequests.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      limit: 20,
    })
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

  it('opens plugin publication reviews as a secondary marketplace view', async () => {
    render(<MarketplaceManagement />)

    await screen.findByText('agent resource')
    fireEvent.mouseDown(screen.getByTestId('admin-plugin-publications-tab'))

    expect(await screen.findByTestId('plugin-publication-review-queue')).toBeInTheDocument()
    await waitFor(() => expect(mockedPublicationApis.listPublicationRequests).toHaveBeenCalled())
    expect(routerReplaceMock).toHaveBeenCalledWith('?tab=marketplace&view=plugin-publications', {
      scroll: false,
    })
  })

  it('restores the plugin publication review view from the URL', async () => {
    searchParamsMock = new URLSearchParams('tab=marketplace&view=plugin-publications')

    render(<MarketplaceManagement />)

    expect(await screen.findByTestId('plugin-publication-review-queue')).toBeInTheDocument()
    expect(mockedAdminApis.getMarketplaceResources).not.toHaveBeenCalled()
    await waitFor(() => expect(mockedPublicationApis.listPublicationRequests).toHaveBeenCalled())
  })
})
