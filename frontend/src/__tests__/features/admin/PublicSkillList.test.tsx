// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import PublicSkillList from '@/features/admin/components/PublicSkillList'
import { fetchPublicSkillsList } from '@/apis/skills'

jest.mock('@/apis/skills', () => ({
  fetchPublicSkillsList: jest.fn(),
  uploadPublicSkill: jest.fn(),
  updatePublicSkillWithUpload: jest.fn(),
  updatePublicSkill: jest.fn(),
  deletePublicSkill: jest.fn(),
  downloadPublicSkill: jest.fn(),
  getPublicSkillContent: jest.fn(),
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}))

jest.mock('@/features/resource-library/useMarketplaceTags', () => ({
  useMarketplaceTags: () => ({
    items: [
      {
        id: 'technical_development',
        name_zh: '技术开发',
        name_en: 'Technical Development',
        sort: 10,
        enabled: true,
      },
    ],
  }),
  getMarketplaceTagLabel: (tag: { name_zh: string; name_en: string }, language: string) =>
    language.startsWith('zh') ? tag.name_zh : tag.name_en,
}))

jest.mock('@/features/resource-library/components/MarketplaceTagsDialog', () => ({
  MarketplaceTagsDialog: ({ resourceId, open }: { resourceId: number | null; open: boolean }) =>
    open ? <div data-testid="marketplace-tags-dialog">resource:{resourceId}</div> : null,
}))

const mockedFetchPublicSkillsList = fetchPublicSkillsList as jest.MockedFunction<
  typeof fetchPublicSkillsList
>

describe('PublicSkillList', () => {
  beforeEach(() => {
    mockedFetchPublicSkillsList.mockReset()
    mockedFetchPublicSkillsList.mockResolvedValue([
      {
        id: 42,
        name: 'data-analysis',
        namespace: 'default',
        description: 'Analyze data',
        tags: ['python'],
        marketplaceTags: ['technical_development'],
        is_active: true,
        is_public: true,
        user_id: 1,
      },
    ])
  })

  it('opens the marketplace tag editor for a public skill', async () => {
    const user = userEvent.setup()
    render(<PublicSkillList />)

    const editButton = await screen.findByTestId('edit-skill-marketplace-tags-button-42')
    await user.click(editButton)

    expect(screen.getByTestId('marketplace-tags-dialog')).toHaveTextContent('resource:42')
  })

  it('shows localized marketplace tags before skill keywords', async () => {
    render(<PublicSkillList />)

    expect(await screen.findByText('技术开发')).toBeInTheDocument()
    expect(screen.queryByText('python')).not.toBeInTheDocument()
  })

  it('falls back to skill keywords when marketplace tags are missing', async () => {
    mockedFetchPublicSkillsList.mockResolvedValue([
      {
        id: 43,
        name: 'legacy-skill',
        namespace: 'default',
        description: 'Legacy skill',
        tags: ['legacy-keyword'],
        marketplaceTags: [],
        is_active: true,
        is_public: true,
        user_id: 1,
      },
    ])

    render(<PublicSkillList />)

    expect(await screen.findByText('legacy-keyword')).toBeInTheDocument()
    expect(screen.getByTestId('public-skill-43-skill-keyword')).toHaveAttribute(
      'title',
      'admin:public_skills.fields.tags'
    )
  })

  it('shows marketplace tag selection when uploading a public skill', async () => {
    const user = userEvent.setup()
    render(<PublicSkillList />)

    await user.click(await screen.findByText('admin:public_skills.upload_skill'))

    expect(screen.getByTestId('marketplace-tag-selector')).toBeInTheDocument()
  })
})
