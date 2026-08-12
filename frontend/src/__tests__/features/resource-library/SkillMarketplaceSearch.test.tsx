// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { downloadSkill, searchSkills } from '@/apis/skillMarketplace'
import { uploadSkill } from '@/apis/skills'
import { SkillMarketplaceSearch } from '@/features/resource-library/components/SkillMarketplaceSearch'

const mockToast = jest.fn()

jest.mock('@/apis/skillMarketplace', () => ({
  downloadSkill: jest.fn(),
  searchSkills: jest.fn(),
}))

jest.mock('@/apis/skills', () => ({
  uploadSkill: jest.fn(),
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => {
      const translations: Record<string, string> = {
        'external_skill_market.title': `Search ${values?.marketName}`,
        'external_skill_market.description': `Install from ${values?.marketName}`,
        'external_skill_market.search_placeholder': `Search ${values?.marketName}`,
        'external_skill_market.search_hint': 'Enter keywords',
        'external_skill_market.search': 'Search',
        'external_skill_market.open_market': `Open ${values?.marketName}`,
        'external_skill_market.searching': 'Searching',
        'external_skill_market.no_results': 'No skills',
        'external_skill_market.public_skill': 'Public',
        'external_skill_market.private_skill': 'Private',
        'external_skill_market.install': 'Install',
        'external_skill_market.installing': 'Installing',
        'external_skill_market.downloading': 'Downloading',
        'external_skill_market.installed': 'Installed',
        'external_skill_market.install_success': 'Installed',
        'external_skill_market.install_success_message': 'Installed skill',
      }
      return translations[key] ?? key
    },
  }),
}))

const mockedSearchSkills = searchSkills as jest.MockedFunction<typeof searchSkills>
const mockedDownloadSkill = downloadSkill as jest.MockedFunction<typeof downloadSkill>
const mockedUploadSkill = uploadSkill as jest.MockedFunction<typeof uploadSkill>

describe('SkillMarketplaceSearch', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedSearchSkills.mockResolvedValue({
      total: 1,
      page: 1,
      pageSize: 20,
      skills: [
        {
          skillKey: 'partner/summary',
          originalSkillKey: 'summary',
          name: 'Summary',
          description: 'Summarizes documents',
          author: 'Partner',
          visibility: 'public',
          tags: ['docs'],
          version: '1.0.0',
          downloadCount: 2,
          createdAt: '2026-08-01T00:00:00Z',
          hasDownloadPermission: true,
          permissionUrl: '',
        },
      ],
    })
    mockedDownloadSkill.mockResolvedValue(new Blob(['skill']))
    mockedUploadSkill.mockResolvedValue({
      apiVersion: 'agent.wecode.io/v1',
      kind: 'Skill',
      metadata: { name: 'summary', namespace: 'engineering' },
      spec: { description: 'Summarizes documents' },
    })
  })

  it('searches and installs through the selected provider', async () => {
    const user = userEvent.setup()
    const onSkillsChange = jest.fn()
    render(
      <SkillMarketplaceSearch
        provider={{
          key: 'partner',
          name: 'Partner Skills',
          marketUrl: 'https://example.test/skills',
        }}
        namespace="engineering"
        onSkillsChange={onSkillsChange}
      />
    )

    await waitFor(() =>
      expect(mockedSearchSkills).toHaveBeenNthCalledWith(1, 'partner', {
        keyword: undefined,
        page: 1,
        pageSize: 20,
      })
    )

    expect(screen.getByTestId('skill-marketplace-search-input-partner')).toBeInTheDocument()
    expect(screen.getByTestId('skill-marketplace-search-button-partner')).toBeInTheDocument()
    await user.type(screen.getByTestId('skill-marketplace-search-input-partner'), 'summary')
    await user.click(screen.getByTestId('skill-marketplace-search-button-partner'))

    expect(await screen.findByText('Summary')).toBeInTheDocument()
    expect(screen.getByTestId('skill-marketplace-grid')).toHaveClass(
      'sm:grid-cols-2',
      'lg:grid-cols-3',
      'xl:grid-cols-4'
    )
    expect(screen.getByTestId('skill-marketplace-card-partner/summary')).toHaveClass(
      'rounded-xl',
      'p-4',
      'hover:shadow-md'
    )
    expect(screen.getByTestId('skill-marketplace-open-partner')).toHaveAttribute(
      'href',
      'https://example.test/skills'
    )
    expect(screen.getByTestId('skill-marketplace-open-partner')).toHaveAttribute('target', '_blank')
    expect(mockedSearchSkills).toHaveBeenNthCalledWith(2, 'partner', {
      keyword: 'summary',
      page: 1,
      pageSize: 20,
    })

    await user.click(screen.getByRole('button', { name: 'Install Summary' }))

    await waitFor(() =>
      expect(mockedDownloadSkill).toHaveBeenCalledWith('partner', 'partner/summary')
    )
    expect(mockedUploadSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'summary.zip' }),
      'summary',
      'engineering'
    )
    expect(onSkillsChange).toHaveBeenCalled()
  })

  it('uses provider-scoped test IDs for pagination controls', async () => {
    mockedSearchSkills.mockResolvedValue({
      total: 40,
      page: 1,
      pageSize: 20,
      skills: [],
    })

    render(
      <SkillMarketplaceSearch
        provider={{ key: 'partner', name: 'Partner Skills' }}
        namespace="engineering"
      />
    )

    expect(await screen.findByTestId('skill-marketplace-previous-partner')).toBeInTheDocument()
    expect(screen.getByTestId('skill-marketplace-next-partner')).toBeInTheDocument()
  })
})
