// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { adminApis } from '@/apis/admin'
import MarketplaceManagement from '@/features/admin/components/MarketplaceManagement'

jest.mock('@/apis/admin', () => ({
  adminApis: {
    getMarketplaceResources: jest.fn(),
    updateMarketplaceResource: jest.fn(),
    getMarketplaceSmartApps: jest.fn(),
    updateMarketplaceSmartApp: jest.fn(),
    importOfficialMarketplaceSmartApp: jest.fn(),
    updateOfficialMarketplaceSmartAppMetadata: jest.fn(),
    deleteOfficialMarketplaceSmartApp: jest.fn(),
  },
}))

jest.mock('@/features/resource-library/components/MarketplaceTagSelector', () => ({
  MarketplaceTagSelector: ({ onChange }: { onChange: (tags: string[]) => void }) => (
    <button
      type="button"
      data-testid="marketplace-tag-option-data_analysis"
      onClick={() => onChange(['data_analysis'])}
    >
      data_analysis
    </button>
  ),
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
    mockedAdminApis.getMarketplaceSmartApps.mockResolvedValue({
      items: [
        {
          id: 33,
          name: 'smart-app',
          display_name: 'Smart App',
          summary: 'Available to everyone',
          description_md: '# Smart App\nClassifies spreadsheet rows.',
          tags: ['data_analysis'],
          icon_url: 'https://example.com/smart-app.png',
          publisher_user_name: 'alice',
          is_system: false,
          featured_rank: 0,
          is_listed: true,
          needs_metadata: false,
        },
      ],
      total: 1,
      page: 1,
      limit: 50,
    })
    mockedAdminApis.updateMarketplaceSmartApp.mockImplementation(async (smartAppId, update) => ({
      id: smartAppId,
      name: 'smart-app',
      display_name: 'Smart App',
      summary: 'Available to everyone',
      description_md: '# Smart App\nClassifies spreadsheet rows.',
      tags: ['data_analysis'],
      icon_url: 'https://example.com/smart-app.png',
      publisher_user_name: 'alice',
      is_system: false,
      featured_rank: update.featured_rank ?? 0,
      is_listed: update.is_listed ?? true,
      needs_metadata: false,
    }))
    mockedAdminApis.importOfficialMarketplaceSmartApp.mockResolvedValue({
      id: 44,
      name: 'official-smart-app',
      display_name: 'Official Smart App',
      summary: 'Imported by an administrator',
      description_md: '# Official Smart App',
      tags: ['data_analysis'],
      icon_url: 'https://example.com/official-smart-app.png',
      publisher_user_name: null,
      is_system: true,
      featured_rank: 0,
      is_listed: true,
      needs_metadata: false,
    })
    mockedAdminApis.updateOfficialMarketplaceSmartAppMetadata.mockResolvedValue({
      id: 44,
      name: 'official-smart-app',
      display_name: 'Official Smart App',
      summary: 'Dashboard summary',
      description_md: '# Dashboard details',
      tags: ['data_analysis'],
      icon_url: 'https://example.com/completed-icon.png',
      publisher_user_name: null,
      is_system: true,
      featured_rank: 0,
      is_listed: true,
      needs_metadata: false,
    })
    mockedAdminApis.deleteOfficialMarketplaceSmartApp.mockResolvedValue(undefined)
  })

  it('loads the Wegent marketplace tabs and updates the recommendation score', async () => {
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
    expect(screen.queryByTestId('marketplace-management-tab-smart-app')).not.toBeInTheDocument()
  })

  it('loads Smart Apps and updates their recommendation score in Smart App mode', async () => {
    render(<MarketplaceManagement mode="smart-app" />)

    await waitFor(() =>
      expect(mockedAdminApis.getMarketplaceSmartApps).toHaveBeenLastCalledWith(1, 50, {
        search: '',
        listingStatus: 'all',
        source: 'all',
      })
    )
    expect(await screen.findByText('Smart App')).toBeInTheDocument()
    expect(screen.getByTestId('marketplace-smart-app-icon-33')).toHaveAttribute(
      'src',
      'https://example.com/smart-app.png'
    )
    expect(screen.getByTestId('marketplace-smart-app-description-33')).toHaveTextContent(
      'Smart App Classifies spreadsheet rows.'
    )
    expect(screen.getByTestId('marketplace-smart-app-filter-listing')).toBeInTheDocument()
    expect(screen.getByTestId('marketplace-smart-app-filter-source')).toBeInTheDocument()
    expect(screen.queryByTestId('marketplace-management-tab-agent')).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId('marketplace-smart-app-filter-search'), {
      target: { value: 'spreadsheet' },
    })
    await waitFor(() =>
      expect(mockedAdminApis.getMarketplaceSmartApps).toHaveBeenLastCalledWith(1, 50, {
        search: 'spreadsheet',
        listingStatus: 'all',
        source: 'all',
      })
    )

    fireEvent.click(screen.getByTestId('marketplace-recommendation-score-33'))
    expect(screen.getByTestId('marketplace-recommendation-score-dialog')).toHaveTextContent(
      'marketplace_management.edit_recommendation_score'
    )
    expect(screen.getByTestId('marketplace-recommendation-score-option-0')).toBeInTheDocument()
    expect(screen.getByTestId('marketplace-recommendation-score-option-80')).toBeInTheDocument()
    expect(screen.getByTestId('marketplace-recommendation-score-option-90')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('marketplace-recommendation-score-input'), {
      target: { value: '100' },
    })
    fireEvent.click(screen.getByTestId('marketplace-recommendation-score-save'))

    await waitFor(() =>
      expect(mockedAdminApis.updateMarketplaceSmartApp).toHaveBeenCalledWith(33, {
        featured_rank: 100,
      })
    )

    fireEvent.click(screen.getByTestId('marketplace-listing-toggle-33'))

    await waitFor(() =>
      expect(mockedAdminApis.updateMarketplaceSmartApp).toHaveBeenCalledWith(33, {
        is_listed: false,
      })
    )
    expect(screen.getByText('marketplace_management.unlisted')).toBeInTheDocument()
  })

  it('reloads a filtered Smart App list after its listing status changes', async () => {
    render(<MarketplaceManagement mode="smart-app" />)
    await screen.findByText('Smart App')

    fireEvent.keyDown(screen.getByTestId('marketplace-smart-app-filter-listing'), {
      key: 'ArrowDown',
    })
    fireEvent.click(
      await screen.findByRole('option', {
        name: 'marketplace_management.smart_app_filters.listed',
      })
    )
    await waitFor(() =>
      expect(mockedAdminApis.getMarketplaceSmartApps).toHaveBeenLastCalledWith(1, 50, {
        search: '',
        listingStatus: 'listed',
        source: 'all',
      })
    )

    mockedAdminApis.getMarketplaceSmartApps.mockClear()
    mockedAdminApis.getMarketplaceSmartApps.mockResolvedValueOnce({
      items: [],
      total: 0,
      page: 1,
      limit: 50,
    })
    fireEvent.click(screen.getByTestId('marketplace-listing-toggle-33'))

    await waitFor(() => expect(mockedAdminApis.getMarketplaceSmartApps).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByText('Smart App')).not.toBeInTheDocument())
  })

  it('imports an uploaded Smart App package as an official app', async () => {
    render(<MarketplaceManagement mode="smart-app" />)
    await screen.findByText('Smart App')
    const packageFile = new File(['official-package'], 'official-smart-app.zip', {
      type: 'application/zip',
    })

    expect(screen.getByTestId('marketplace-official-app-import')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('marketplace-official-app-file'), {
      target: { files: [packageFile] },
    })

    await waitFor(() =>
      expect(mockedAdminApis.importOfficialMarketplaceSmartApp).toHaveBeenCalledWith(packageFile)
    )
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith({
        title: 'marketplace_management.official_import_success',
      })
    )
  })

  it('imports a plain Wework package before asking for marketplace details', async () => {
    mockedAdminApis.importOfficialMarketplaceSmartApp.mockResolvedValueOnce({
      id: 44,
      name: 'official-smart-app',
      display_name: 'Official Smart App',
      summary: 'Manifest description',
      description_md: 'Manifest description',
      tags: [],
      icon_url: '',
      publisher_user_name: null,
      is_system: true,
      featured_rank: 0,
      is_listed: true,
      needs_metadata: true,
    })
    render(<MarketplaceManagement mode="smart-app" />)
    await screen.findByText('Smart App')
    const packageFile = new File(['plain-package'], 'plain-smart-app.zip', {
      type: 'application/zip',
    })

    fireEvent.change(screen.getByTestId('marketplace-official-app-file'), {
      target: { files: [packageFile] },
    })

    expect(await screen.findByTestId('marketplace-smart-app-metadata-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('marketplace-smart-app-metadata-summary')).toHaveValue(
      'Manifest description'
    )
    fireEvent.change(screen.getByTestId('marketplace-smart-app-metadata-summary'), {
      target: { value: 'Dashboard summary' },
    })
    fireEvent.change(screen.getByTestId('marketplace-smart-app-metadata-description'), {
      target: { value: '# Dashboard details' },
    })
    fireEvent.click(screen.getByTestId('marketplace-tag-option-data_analysis'))
    const icon = new File(['icon'], 'icon.png', { type: 'image/png' })
    fireEvent.change(screen.getByTestId('marketplace-smart-app-metadata-icon'), {
      target: { files: [icon] },
    })
    fireEvent.click(screen.getByTestId('marketplace-smart-app-metadata-save'))

    await waitFor(() =>
      expect(mockedAdminApis.updateOfficialMarketplaceSmartAppMetadata).toHaveBeenCalledWith(44, {
        summary: 'Dashboard summary',
        descriptionMd: '# Dashboard details',
        tags: ['data_analysis'],
        icon,
      })
    )
  })

  it('permanently deletes an official Smart App after confirmation', async () => {
    const user = userEvent.setup()
    mockedAdminApis.getMarketplaceSmartApps.mockResolvedValueOnce({
      items: [
        {
          id: 44,
          name: 'official-smart-app',
          display_name: 'Official Smart App',
          summary: 'Official app',
          description_md: '# Official app',
          tags: ['data_analysis'],
          icon_url: 'https://example.com/official-smart-app.png',
          publisher_user_name: null,
          is_system: true,
          featured_rank: 80,
          is_listed: true,
          needs_metadata: false,
        },
      ],
      total: 1,
      page: 1,
      limit: 50,
    })
    render(<MarketplaceManagement mode="smart-app" />)

    await screen.findByText('Official Smart App')
    expect(screen.queryByTestId('marketplace-smart-app-delete-44')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('marketplace-smart-app-more-44'))
    await user.click(await screen.findByTestId('marketplace-smart-app-delete-44'))

    expect(screen.getByTestId('marketplace-smart-app-delete-dialog')).toHaveTextContent(
      'marketplace_management.delete_title'
    )
    fireEvent.click(screen.getByTestId('marketplace-smart-app-delete-confirm'))

    await waitFor(() =>
      expect(mockedAdminApis.deleteOfficialMarketplaceSmartApp).toHaveBeenCalledWith(44)
    )
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith({
        title: 'marketplace_management.delete_success',
      })
    )
  })
})
